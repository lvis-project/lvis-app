import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";
import { PluginHookTrustStore, preparePluginHookGeneration } from "../hooks/plugin-hook-projection.js";
import type { SkillStore } from "../main/skill-store.js";
import type { McpManager, PreparedBundledMcpGeneration } from "../mcp/mcp-manager.js";
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
  CommittedPluginGeneration,
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
import {
  opaqueHealthError,
  PluginGenerationHealthJournal,
  pluginGenerationHealthJournalPath,
  type PluginGenerationHealthFault,
} from "./plugin-generation-health-journal.js";

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
    | "prepareRuntimeRemoval"
    | "postPublishRuntimeGeneration"
    | "publishRuntimeGeneration"
    | "unpublishRuntimeGeneration"
    | "retireRuntimeGeneration"
  >;
  receiptCacheRoot: string;
  skillStore: SkillStore;
  hookManager: ScriptHookManager;
  mcpManager: McpManager;
  loopbackManager: Pick<PluginLoopbackManager,
    | "prepareGeneration"
    | "prepareRemoval"
    | "publishGeneration"
    | "postPublishGeneration"
    | "discardGeneration"
    | "retireGeneration"
  >;
  hookTrust?: PluginHookTrustStore;
  mcpTrust?: PluginMcpTrustStore;
  revokeOperationGeneration: (pluginId: string, generationId: string) => void;
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
  private readonly healthJournal: PluginGenerationHealthJournal;
  private readonly retirementTasks = new Set<Promise<void>>();

  constructor(private readonly deps: PluginBundleLifecycleDeps) {
    if (typeof deps.receiptCacheRoot !== "string" || deps.receiptCacheRoot.trim().length === 0) {
      throw new Error("PluginBundleLifecycle requires a non-empty receiptCacheRoot");
    }
    if (!deps.loopbackManager || typeof deps.loopbackManager.prepareGeneration !== "function") {
      throw new Error("PluginBundleLifecycle requires the loopback generation manager");
    }
    if (typeof deps.revokeOperationGeneration !== "function") {
      throw new Error("PluginBundleLifecycle requires exact operation-generation revocation");
    }
    this.hookTrust = deps.hookTrust ?? new PluginHookTrustStore(
      resolve(deps.receiptCacheRoot, "plugin-contribution-trust", "hooks.json"),
    );
    this.mcpTrust = deps.mcpTrust ?? new PluginMcpTrustStore(
      resolve(deps.receiptCacheRoot, "plugin-contribution-trust", "mcp-servers.json"),
    );
    this.retirementJournal = new PluginRetirementJournal(pluginRetirementJournalPath(deps.receiptCacheRoot));
    this.healthJournal = new PluginGenerationHealthJournal(
      pluginGenerationHealthJournalPath(deps.receiptCacheRoot),
    );
  }

  activate(pluginId: string): Promise<void> {
    return this.serialize(pluginId, () => this.activateNow(pluginId));
  }

  replaceRuntime(runtime: PluginRuntimeGenerationProjection): Promise<void> {
    return this.serialize(runtime.manifest.id, async () => {
      await this.replaceRuntimeNow(runtime);
    });
  }

  async replaceRuntimeWithCommit<T>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRaw: string,
    durableCommit: () => Promise<T>,
  ): Promise<CommittedPluginGeneration<T>> {
    let committed!: CommittedPluginGeneration<T>;
    await this.serialize(runtime.manifest.id, async () => {
      committed = await this.replaceRuntimeNow(runtime, receiptRaw, durableCommit);
    });
    return committed;
  }

  deactivate(pluginId: string): Promise<void> {
    return this.serialize(pluginId, () => this.deactivateNow(pluginId));
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

  runWithLease<T>(
    lease: PluginGenerationLease<HostPluginGenerationState>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.coordinator.runWithLease(lease, operation);
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
        const preparedHooks = this.deps.hookManager.preparePluginGeneration(
          generation.state.hooks,
          this.hookTrust,
          { pluginId, generationId: generation.generationId },
        );
        await this.coordinator.quiesce(
          pluginId,
          generation.generationId,
          async () => undefined,
          () => preparedHooks.publish(),
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
      let prepared: PreparedBundledMcpGeneration | undefined;
      try {
        const candidate = await this.deps.mcpManager.prepareBundledGeneration(
          { pluginId, generationId: generation.generationId },
          generation.state.mcpServers,
          this.mcpTrust,
        );
        prepared = candidate;
        await this.coordinator.quiesce(
          pluginId,
          generation.generationId,
          async () => undefined,
          () => this.deps.mcpManager.publishBundledGeneration(candidate),
        );
      } catch (error) {
        if (prepared?.published) {
          this.recordPostCommitFault(
            pluginId,
            generation.generationId,
            "mcp-publication",
            error,
          );
          this.trackPublishedMcpRetirement(pluginId, generation.generationId, prepared);
          return;
        }
        if (wasApproved) this.mcpTrust.approve(projection);
        else this.mcpTrust.revoke(projection);
        if (prepared) await this.deps.mcpManager.discardBundledGeneration(prepared);
        throw error;
      }
      if (!prepared) throw new Error("bundled MCP preparation completed without a candidate");
      this.trackPublishedMcpRetirement(pluginId, generation.generationId, prepared);
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

  private async replaceRuntimeNow<T = void>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRawOverride?: string,
    durableCommit?: () => Promise<T>,
  ): Promise<CommittedPluginGeneration<T>> {
    const manifest = runtime.manifest;
    const pluginRoot = runtime.pluginRoot;
    const pluginId = manifest.id;
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf8");
    const receiptRaw = receiptRawOverride
      ?? await readFile(installReceiptPath(this.deps.receiptCacheRoot, pluginId), "utf8");
    const artifactGenerationId = createHash("sha256")
      .update(manifestRaw)
      .update("\0")
      .update(receiptRaw)
      .digest("hex");
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(runtime.activationId)
      .digest("hex");
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
      artifactGenerationId,
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
    const predecessorMcpServerIds = this.deps.mcpManager.bundledServerIdsForPlugin(pluginId);
    const preparedRuntime = this.deps.pluginRuntime.prepareRuntimeGeneration(candidate.state.runtime);
    const preparedSkills = this.deps.skillStore.preparePluginGeneration(candidate);
    const preparedHooks = this.deps.hookManager.preparePluginGeneration(
      candidate.state.hooks,
      this.hookTrust,
      { pluginId, generationId: candidate.generationId },
    );
    // ToolRegistry reservation is prepared last so any earlier preparation
    // failure cannot strand the global publication reservation.
    const preparedLoopback = await this.deps.loopbackManager.prepareGeneration(
      candidate.state.runtime.manifest,
      candidate.generationId,
      predecessorMcpServerIds,
    );
    const predecessor = this.coordinator.getActive(pluginId);

    let published;
    let result!: T;
    try {
      published = await this.coordinator.commit(
        candidate,
        async () => {
          if (durableCommit) result = await durableCommit();
        },
        (predecessor) => this.retire(predecessor),
        pluginId,
        () => {
          this.deps.loopbackManager.publishGeneration(preparedLoopback);
          preparedRuntime.publish();
          preparedSkills.publish();
          preparedHooks.publish();
        },
      );
    } catch (error) {
      candidate.state.runtime.hostEffects?.discard();
      await this.deps.loopbackManager.discardGeneration(preparedLoopback);
      throw error;
    }
    try {
      await this.deps.pluginRuntime.postPublishRuntimeGeneration(candidate.state.runtime);
    } catch (error) {
      this.recordPostCommitFault(pluginId, candidate.generationId, "runtime-post-publish", error);
    }
    try {
      this.deps.loopbackManager.postPublishGeneration(preparedLoopback);
    } catch (error) {
      this.recordPostCommitFault(pluginId, candidate.generationId, "loopback-post-publish", error);
    }
    try {
      // Provider/connect failures are already represented by McpManager as a
      // typed same-generation degraded record. Reaching this catch is an
      // internal publication/contract fault and receives durable health state.
      await this.projectApprovedMcp(candidate);
    } catch (error) {
      this.recordPostCommitFault(pluginId, candidate.generationId, "mcp-publication", error);
    }
    const retirement = predecessor && predecessor.generationId !== candidate.generationId
      ? this.trackRetirement(predecessor, published.retired)
      : Promise.resolve();
    return Object.freeze({ result, retirement });
  }

  private async deactivateNow<T = void>(
    pluginId: string,
    durableCommit?: () => Promise<T>,
  ): Promise<T> {
    let result!: T;
    const active = this.coordinator.getActive(pluginId);
    const bundledServerIds = this.deps.mcpManager.bundledServerIdsForPlugin(pluginId);
    if (!active) {
      if (this.deps.pluginRuntime.getRuntimeGenerationProjection(pluginId) || bundledServerIds.length > 0) {
        throw new Error(`plugin '${pluginId}' has live projections without an active bundle generation`);
      }
      if (durableCommit) result = await durableCommit();
      return result;
    }
    const preparedLoopback = this.deps.loopbackManager.prepareRemoval(
      pluginId,
      active.generationId,
      bundledServerIds,
    );
    const preparedRuntime = this.deps.pluginRuntime.prepareRuntimeRemoval(pluginId);
    const preparedSkills = this.deps.skillStore.preparePluginRemoval(pluginId, active.generationId);
    const preparedHooks = this.deps.hookManager.preparePluginGeneration(
      [],
      this.hookTrust,
      { pluginId, generationId: active.generationId },
    );
    let published;
    try {
      published = await this.coordinator.commit(
        undefined,
        async () => {
          if (durableCommit) result = await durableCommit();
        },
        (predecessor) => this.retire(predecessor),
        pluginId,
        () => {
          this.deps.loopbackManager.publishGeneration(preparedLoopback);
          preparedRuntime.publish();
          preparedSkills.publish();
          preparedHooks.publish();
        },
      );
    } catch (error) {
      await this.deps.loopbackManager.discardGeneration(preparedLoopback);
      throw error;
    }
    this.deps.loopbackManager.postPublishGeneration(preparedLoopback);
    this.trackRetirement(active, published.retired);
    return result;
  }

  /**
   * External MCP work is deliberately post-pointer. Exact trust is evaluated
   * only after the immutable generation is active; connection/discovery failure
   * leaves that generation active with a typed zero-tool degraded projection.
   */
  private async projectApprovedMcp(
    generation: ActivePluginGeneration<HostPluginGenerationState>,
  ): Promise<void> {
    let prepared: Awaited<ReturnType<McpManager["prepareBundledGeneration"]>> | undefined;
    try {
      prepared = await this.deps.mcpManager.prepareBundledGeneration(
        { pluginId: generation.pluginId, generationId: generation.generationId },
        generation.state.mcpServers,
        this.mcpTrust,
      );
      const publication = prepared;
      await this.coordinator.quiesce(
        generation.pluginId,
        generation.generationId,
        async () => undefined,
        () => this.deps.mcpManager.publishBundledGeneration(publication),
      );
      await this.deps.mcpManager.retirePublishedMcpReplacement(publication);
    } catch (error) {
      if (prepared) await this.deps.mcpManager.discardBundledGeneration(prepared);
      // Expected provider/connect failures are represented as typed degraded
      // records by prepareBundledGeneration. Everything reaching this catch is
      // an internal contract or publication failure and must remain visible.
      throw error;
    }
  }

  private async retire(generation: ActivePluginGeneration<HostPluginGenerationState>): Promise<void> {
    this.retirementJournal.record(generation.pluginId, generation.generationId);
    this.deps.revokeOperationGeneration(generation.pluginId, generation.generationId);
    const errors: Error[] = [];
    try { this.deps.skillStore.removePluginGeneration(generation.pluginId, generation.generationId); } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try { this.deps.hookManager.removePluginGeneration(generation.pluginId, generation.generationId); } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    // Current-turn Skill overlays own generation leases. They release at the
    // turn boundary, so coordinator drain itself guarantees the body remains
    // available for every subsequent assistant round of the admitted turn.
    try { await this.deps.mcpManager.disconnectBundledGeneration(generation.pluginId, generation.generationId); } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try { await this.deps.loopbackManager.retireGeneration(generation.pluginId, generation.generationId); } catch (error) {
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
    this.healthJournal.clearGeneration(generation.pluginId, generation.generationId);
  }

  private recordPostCommitFault(
    pluginId: string,
    generationId: string,
    phase: PluginGenerationHealthFault["phase"],
    error: unknown,
  ): void {
    try {
      this.healthJournal.record(pluginId, generationId, phase, error);
    } catch (journalError) {
      const journalFault = opaqueHealthError(journalError);
      log.error(
        `plugin generation health journal failed (${pluginId}:${generationId}:${phase}) error=%s code=%s`,
        journalFault.errorName,
        journalFault.errorCode ?? "none",
      );
      return;
    }
    const fault = opaqueHealthError(error);
    log.error(
      `plugin generation internal post-commit fault (${pluginId}:${generationId}:${phase}) error=%s code=%s`,
      fault.errorName,
      fault.errorCode ?? "none",
    );
  }

  private trackRetirement(
    generation: ActivePluginGeneration<HostPluginGenerationState>,
    initial: Promise<void>,
  ): Promise<void> {
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
    return task;
  }

  private trackPublishedMcpRetirement(
    pluginId: string,
    generationId: string,
    prepared: Parameters<McpManager["retirePublishedMcpReplacement"]>[0],
  ): void {
    const task = (async () => {
      for (let attempt = 1; attempt <= MAX_RETIREMENT_ATTEMPTS; attempt += 1) {
        try {
          await this.deps.mcpManager.retirePublishedMcpReplacement(prepared);
          return;
        } catch (error) {
          if (attempt === MAX_RETIREMENT_ATTEMPTS) {
            this.recordPostCommitFault(
              pluginId,
              generationId,
              "mcp-predecessor-retirement",
              error,
            );
            return;
          }
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, attempt * 100));
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
