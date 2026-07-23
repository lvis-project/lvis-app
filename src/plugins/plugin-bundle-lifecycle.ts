import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";
import { PluginHookTrustStore, preparePluginHookGeneration } from "../hooks/plugin-hook-projection.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillStore } from "../main/skill-store.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { PluginLoopbackManager } from "../mcp/plugin-loopback-manager.js";
import { PluginMcpTrustStore, preparePluginMcpGeneration } from "../mcp/plugin-mcp-projection.js";
import { installReceiptPath } from "./plugin-install-receipt.js";
import {
  materializePluginContributions,
  materializePluginGenerationRoot,
  removeRetainedPluginGeneration,
} from "./plugin-contributions.js";
import { PluginGenerationCoordinator, type ActivePluginGeneration } from "./plugin-generation-coordinator.js";
import type { PluginRuntime } from "./runtime.js";
import type {
  HostPluginGenerationState,
  PluginRuntimeGenerationLifecycle,
  PluginRuntimeGenerationProjection,
} from "./plugin-host-generation.js";
import type { PluginGenerationLease } from "./plugin-generation-coordinator.js";
import { createLogger } from "../lib/logger.js";
import {
  PluginRetirementJournal,
  pluginRetirementJournalPath,
} from "./plugin-retirement-journal.js";

const log = createLogger("plugin-bundle-lifecycle");
const MAX_RETIREMENT_ATTEMPTS = 3;

export interface PluginBundleLifecycleHandler extends PluginRuntimeGenerationLifecycle {
  activate(pluginId: string): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
}

export interface PluginBundleLifecycleDeps {
  pluginRuntime: Pick<PluginRuntime,
    | "getPluginManifest"
    | "getPluginRoot"
    | "getRuntimeGenerationProjection"
    | "prepareRuntimeGeneration"
    | "postPublishRuntimeGeneration"
    | "publishRuntimeGeneration"
    | "unpublishRuntimeGeneration"
    | "retireRuntimeGeneration"
  >;
  receiptCacheRoot: string;
  skillStore: SkillStore;
  skillOverlay: SkillOverlay;
  hookManager: ScriptHookManager;
  mcpManager: McpManager;
  loopbackManager?: Pick<PluginLoopbackManager, "start" | "stop">;
  hookTrust?: PluginHookTrustStore;
  mcpTrust?: PluginMcpTrustStore;
}

export interface PluginContributionTrustRow {
  kind: "hook" | "mcpServer";
  pluginId: string;
  pluginVersion: string;
  generationId: string;
  localId: string;
  fingerprint: string;
  status: "approved" | "approval_required";
}

/**
 * Converges the three plugin-owned projections on one verified generation.
 * Operations for one plugin are serialized; malformed candidates are prepared
 * entirely before the active generation changes. Hook/MCP authority remains
 * fail-closed until an exact trust record is supplied.
 */
export class PluginBundleLifecycle implements PluginBundleLifecycleHandler {
  readonly hookTrust: PluginHookTrustStore;
  readonly mcpTrust: PluginMcpTrustStore;
  private readonly coordinator = new PluginGenerationCoordinator<HostPluginGenerationState>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly retirementJournal: PluginRetirementJournal;
  private readonly retirementTasks = new Set<Promise<void>>();

  constructor(private readonly deps: PluginBundleLifecycleDeps) {
    this.hookTrust = deps.hookTrust ?? new PluginHookTrustStore(
      resolve(deps.receiptCacheRoot, "plugin-contribution-trust", "hooks.json"),
    );
    this.mcpTrust = deps.mcpTrust ?? new PluginMcpTrustStore(
      resolve(deps.receiptCacheRoot, "plugin-contribution-trust", "mcp-servers.json"),
    );
    this.retirementJournal = new PluginRetirementJournal(pluginRetirementJournalPath(deps.receiptCacheRoot));
  }

  activate(pluginId: string): Promise<void> {
    return this.serialize(pluginId, () => this.activateNow(pluginId));
  }

  replaceRuntime(runtime: PluginRuntimeGenerationProjection): Promise<void> {
    return this.serialize(runtime.manifest.id, () => this.replaceRuntimeNow(runtime));
  }

  deactivate(pluginId: string): Promise<void> {
    return this.serialize(pluginId, () => this.deactivateNow(pluginId));
  }

  setContributionsEnabled(pluginId: string, enabled: boolean): Promise<void> {
    return this.serialize(pluginId, () => this.setContributionsEnabledNow(pluginId, enabled));
  }

  async deactivateWithCommit<T>(pluginId: string, durableCommit: () => Promise<T>): Promise<T> {
    let result!: T;
    await this.serialize(pluginId, async () => {
      result = await this.deactivateNow(pluginId, durableCommit);
    });
    return result;
  }

  getActive(pluginId: string): ActivePluginGeneration<HostPluginGenerationState> | undefined {
    return this.coordinator.getActive(pluginId);
  }

  acquire(pluginId: string): Promise<PluginGenerationLease<HostPluginGenerationState>> {
    return this.coordinator.acquire(pluginId);
  }

  acquireExact(pluginId: string, generationId: string): Promise<PluginGenerationLease<HostPluginGenerationState>> {
    return this.coordinator.acquireExact(pluginId, generationId);
  }

  waitForRetirements(): Promise<void> {
    return this.waitForTrackedRetirements();
  }

  async recoverRetirements(): Promise<void> {
    for (const record of this.retirementJournal.list()) {
      const active = this.coordinator.getActive(record.pluginId);
      if (active?.generationId === record.generationId) {
        throw new Error(`retirement journal targets active plugin generation '${record.pluginId}:${record.generationId}'`);
      }
      await removeRetainedPluginGeneration(
        this.deps.receiptCacheRoot,
        record.pluginId,
        record.generationId,
      );
      this.retirementJournal.complete(record.pluginId, record.generationId);
    }
    const cacheEntries = await readdir(this.deps.receiptCacheRoot, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of cacheEntries) {
      if (!entry.isDirectory()) continue;
      const generationEntries = await readdir(
        resolve(this.deps.receiptCacheRoot, entry.name, "generations"),
        { withFileTypes: true },
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      const activeGenerationId = this.coordinator.getActive(entry.name)?.generationId;
      for (const generationEntry of generationEntries) {
        if (!generationEntry.isDirectory() || generationEntry.name === activeGenerationId) continue;
        if (!/^[a-f0-9]{64}$/.test(generationEntry.name)) continue;
        await removeRetainedPluginGeneration(this.deps.receiptCacheRoot, entry.name, generationEntry.name);
      }
    }
  }

  async approveHook(pluginId: string, localId: string): Promise<void> {
    await this.updateHookTrust(pluginId, localId, true);
  }

  async revokeHook(pluginId: string, localId: string): Promise<void> {
    await this.updateHookTrust(pluginId, localId, false);
  }

  async approveMcpServer(pluginId: string, localId: string): Promise<void> {
    await this.updateMcpTrust(pluginId, localId, true);
  }

  async revokeMcpServer(pluginId: string, localId: string): Promise<void> {
    await this.updateMcpTrust(pluginId, localId, false);
  }

  listContributionTrust(pluginId?: string): PluginContributionTrustRow[] {
    const generations = pluginId
      ? [this.coordinator.getActive(pluginId)].filter((entry): entry is ActivePluginGeneration<HostPluginGenerationState> => Boolean(entry))
      : [...this.coordinator.listActive()];
    return generations.flatMap((generation) => [
      ...generation.state.hooks.map((projection): PluginContributionTrustRow => ({
        kind: "hook",
        ...projection.owner,
        status: this.hookTrust.isApproved(projection) ? "approved" : "approval_required",
      })),
      ...generation.state.mcpServers.map((projection): PluginContributionTrustRow => ({
        kind: "mcpServer",
        ...projection.owner,
        status: this.mcpTrust.isApproved(projection) ? "approved" : "approval_required",
      })),
    ]);
  }

  private async updateHookTrust(pluginId: string, localId: string, approve: boolean): Promise<void> {
    await this.serialize(pluginId, async () => {
      const generation = this.requireActive(pluginId);
      const projection = generation.state.hooks.find((entry) => entry.owner.localId === localId);
      if (!projection) throw new Error(`plugin Hook '${pluginId}:${localId}' is not active`);
      const wasApproved = this.hookTrust.isApproved(projection);
      if (approve) this.hookTrust.approve(projection);
      else this.hookTrust.revoke(projection);
      try {
        await this.coordinator.quiesce(
          pluginId,
          generation.generationId,
          async () => undefined,
          () => this.deps.hookManager.publishPluginGeneration(generation.state.hooks, this.hookTrust),
        );
      } catch (error) {
        if (wasApproved) this.hookTrust.approve(projection);
        else this.hookTrust.revoke(projection);
        throw error;
      }
    });
  }

  private async updateMcpTrust(pluginId: string, localId: string, approve: boolean): Promise<void> {
    await this.serialize(pluginId, async () => {
      const generation = this.requireActive(pluginId);
      const projection = generation.state.mcpServers.find((entry) => entry.owner.localId === localId);
      if (!projection) throw new Error(`plugin MCP '${pluginId}:${localId}' is not active`);
      const wasApproved = this.mcpTrust.isApproved(projection);
      if (approve) this.mcpTrust.approve(projection);
      else this.mcpTrust.revoke(projection);
      const prepared = await this.deps.mcpManager.prepareBundledGeneration(
        { pluginId, generationId: generation.generationId },
        generation.state.mcpServers,
        this.mcpTrust,
      );
      try {
        await this.coordinator.quiesce(
          pluginId,
          generation.generationId,
          async () => undefined,
          () => this.deps.mcpManager.publishBundledGeneration(prepared),
        );
        await this.deps.mcpManager.retirePublishedMcpReplacement(prepared);
      } catch (error) {
        if (wasApproved) this.mcpTrust.approve(projection);
        else this.mcpTrust.revoke(projection);
        await this.deps.mcpManager.discardBundledGeneration(prepared);
        throw error;
      }
    });
  }

  private requireActive(pluginId: string): ActivePluginGeneration<HostPluginGenerationState> {
    const generation = this.coordinator.getActive(pluginId);
    if (!generation) throw new Error(`plugin '${pluginId}' has no active bundle generation`);
    return generation;
  }

  private serialize(pluginId: string, operation: () => Promise<void>): Promise<void> {
    const prior = this.tails.get(pluginId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.tails.set(pluginId, next);
    return next.finally(() => {
      if (this.tails.get(pluginId) === next) this.tails.delete(pluginId);
    });
  }

  private async activateNow(pluginId: string): Promise<void> {
    const runtime = this.deps.pluginRuntime.getRuntimeGenerationProjection(pluginId);
    if (!runtime) throw new Error(`plugin '${pluginId}' is not loaded`);
    await this.replaceRuntimeNow(runtime);
  }

  private async replaceRuntimeNow(runtime: PluginRuntimeGenerationProjection): Promise<void> {
    const manifest = runtime.manifest;
    const pluginRoot = runtime.pluginRoot;
    const pluginId = manifest.id;
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf8");
    const receiptRaw = await readFile(installReceiptPath(this.deps.receiptCacheRoot, pluginId), "utf8");
    const generationId = createHash("sha256").update(manifestRaw).update("\0").update(receiptRaw).digest("hex");
    const payloadRoot = await materializePluginGenerationRoot(
      pluginRoot,
      this.deps.receiptCacheRoot,
      pluginId,
      generationId,
      receiptRaw,
    );
    const contributions = await materializePluginContributions(payloadRoot, manifest);
    const identity = {
      pluginId,
      pluginVersion: manifest.version,
      generationId,
      manifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
      receiptSha256: createHash("sha256").update(receiptRaw).digest("hex"),
      contributions,
    };
    const preparationView: ActivePluginGeneration = { ...identity, state: undefined };
    const candidate: ActivePluginGeneration<HostPluginGenerationState> = {
      ...identity,
      state: Object.freeze({
        payloadRoot,
        runtime,
        hooks: await preparePluginHookGeneration(preparationView, payloadRoot),
        mcpServers: await preparePluginMcpGeneration(preparationView, payloadRoot),
      }),
    };
    candidate.state.runtime.hostEffects?.bindGeneration(this, candidate.generationId);
    const preparedMcp = await this.deps.mcpManager.prepareBundledGeneration(
      { pluginId, generationId: candidate.generationId },
      candidate.state.mcpServers,
      this.mcpTrust,
    );
    const predecessor = this.coordinator.getActive(pluginId);

    let published;
    try {
      published = await this.coordinator.commit(
        candidate,
        async () => {
          this.deps.pluginRuntime.prepareRuntimeGeneration(candidate.state.runtime);
        // The loopback host validates its complete tool surface before its own
        // atomic registry swap. Calls admitted through that surface remain
        // blocked by this coordinator's transition barrier until pointer publish.
        await this.deps.loopbackManager?.start(candidate.state.runtime.manifest);
        },
        (predecessor) => this.retire(predecessor),
        pluginId,
        () => {
          this.deps.mcpManager.publishBundledGeneration(preparedMcp);
          this.deps.pluginRuntime.publishRuntimeGeneration(candidate.state.runtime);
          this.deps.skillStore.publishPluginGeneration(candidate);
          this.deps.hookManager.publishPluginGeneration(candidate.state.hooks, this.hookTrust);
        },
      );
    } catch (error) {
      candidate.state.runtime.hostEffects?.discard();
      await this.deps.mcpManager.discardBundledGeneration(preparedMcp);
      throw error;
    }
    await this.deps.pluginRuntime.postPublishRuntimeGeneration(candidate.state.runtime);
    if (predecessor && predecessor.generationId !== candidate.generationId) {
      this.trackRetirement(predecessor, published.retired);
    }
  }

  private async deactivateNow<T = void>(
    pluginId: string,
    durableCommit?: () => Promise<T>,
  ): Promise<T> {
    let result!: T;
    const active = this.coordinator.getActive(pluginId);
    const preparedMcp = await this.deps.mcpManager.prepareBundledGeneration(
      { pluginId, generationId: active?.generationId ?? "inactive" },
      [],
      this.mcpTrust,
    );
    let published;
    try {
      published = await this.coordinator.commit(
        undefined,
        async () => {
          if (durableCommit) result = await durableCommit();
          await this.deps.loopbackManager?.stop(pluginId);
        },
        (predecessor) => this.retire(predecessor),
        pluginId,
        () => {
          this.deps.mcpManager.publishBundledGeneration(preparedMcp);
          this.deps.pluginRuntime.unpublishRuntimeGeneration(pluginId);
          this.deps.skillStore.removePlugin(pluginId);
          this.deps.hookManager.removePlugin(pluginId);
        },
      );
    } catch (error) {
      await this.deps.mcpManager.discardBundledGeneration(preparedMcp);
      throw error;
    }
    if (active) this.trackRetirement(active, published.retired);
    return result;
  }

  private async setContributionsEnabledNow(pluginId: string, enabled: boolean): Promise<void> {
    const generation = this.requireActive(pluginId);
    const preparedMcp = await this.deps.mcpManager.prepareBundledGeneration(
      { pluginId, generationId: generation.generationId },
      enabled ? generation.state.mcpServers : [],
      this.mcpTrust,
    );
    try {
      await this.coordinator.quiesce(
        pluginId,
        generation.generationId,
        async () => {
          if (enabled) await this.deps.loopbackManager?.start(generation.state.runtime.manifest);
          else await this.deps.loopbackManager?.stop(pluginId);
        },
        () => {
          this.deps.mcpManager.publishBundledGeneration(preparedMcp);
          if (enabled) {
            generation.state.runtime.hostEffects?.resume();
            this.deps.skillStore.publishPluginGeneration(generation);
            this.deps.hookManager.publishPluginGeneration(generation.state.hooks, this.hookTrust);
          } else {
            generation.state.runtime.hostEffects?.supersede();
            this.deps.skillStore.removePlugin(pluginId);
            this.deps.hookManager.removePlugin(pluginId);
          }
        },
      );
    } catch (error) {
      await this.deps.mcpManager.discardBundledGeneration(preparedMcp);
      throw error;
    }
    if (!enabled) {
      await this.deps.mcpManager.disconnectBundledGeneration(pluginId, generation.generationId);
    }
  }

  private async retire(generation: ActivePluginGeneration<HostPluginGenerationState>): Promise<void> {
    this.retirementJournal.record(generation.pluginId, generation.generationId);
    const errors: Error[] = [];
    try { this.deps.skillOverlay.clearPluginGeneration(generation.pluginId, generation.generationId); } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try { await this.deps.mcpManager.disconnectBundledGeneration(generation.pluginId, generation.generationId); } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try { await this.deps.pluginRuntime.retireRuntimeGeneration(generation.state.runtime); } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (errors.length > 0) {
      const aggregate = new AggregateError(errors, `plugin '${generation.pluginId}' generation retirement failed`);
      this.retirementJournal.record(generation.pluginId, generation.generationId, aggregate);
      throw aggregate;
    }
    await removeRetainedPluginGeneration(this.deps.receiptCacheRoot, generation.pluginId, generation.generationId);
    this.retirementJournal.complete(generation.pluginId, generation.generationId);
  }

  private trackRetirement(
    generation: ActivePluginGeneration<HostPluginGenerationState>,
    initial: Promise<void>,
  ): void {
    const task = (async () => {
      let attempt = 1;
      let current = initial;
      while (true) {
        try {
          await current;
          return;
        } catch (error) {
          log.error(
            `plugin generation retirement failed (${generation.pluginId}:${generation.generationId}, attempt ${attempt}): %s`,
            error instanceof Error ? error.message : String(error),
          );
          if (attempt >= MAX_RETIREMENT_ATTEMPTS) throw error;
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 100));
          attempt += 1;
          current = this.retire(generation);
        }
      }
    })();
    this.retirementTasks.add(task);
    void task.finally(() => this.retirementTasks.delete(task)).catch(() => undefined);
  }

  private async waitForTrackedRetirements(): Promise<void> {
    while (this.retirementTasks.size > 0) {
      await Promise.all([...this.retirementTasks]);
    }
  }
}
