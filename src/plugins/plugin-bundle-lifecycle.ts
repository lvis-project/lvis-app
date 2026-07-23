import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";
import { PluginHookTrustStore, preparePluginHookGeneration, type PreparedPluginHookProjection } from "../hooks/plugin-hook-projection.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillStore } from "../main/skill-store.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import { PluginMcpTrustStore, preparePluginMcpGeneration, type PreparedPluginMcpProjection } from "../mcp/plugin-mcp-projection.js";
import { installReceiptPath } from "./plugin-install-receipt.js";
import { materializePluginContributions } from "./plugin-contributions.js";
import { PluginGenerationCoordinator, type ActivePluginGeneration } from "./plugin-generation-coordinator.js";
import type { PluginRuntime } from "./runtime.js";

interface BundleGenerationState {
  hooks: readonly PreparedPluginHookProjection[];
  mcpServers: readonly PreparedPluginMcpProjection[];
}

export interface PluginBundleLifecycleHandler {
  activate(pluginId: string): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
}

export interface PluginBundleLifecycleDeps {
  pluginRuntime: Pick<PluginRuntime, "getPluginManifest" | "getPluginRoot">;
  receiptCacheRoot: string;
  skillStore: SkillStore;
  skillOverlay: SkillOverlay;
  hookManager: ScriptHookManager;
  mcpManager: McpManager;
  hookTrust?: PluginHookTrustStore;
  mcpTrust?: PluginMcpTrustStore;
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
  private readonly coordinator = new PluginGenerationCoordinator<BundleGenerationState>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly deps: PluginBundleLifecycleDeps) {
    this.hookTrust = deps.hookTrust ?? new PluginHookTrustStore();
    this.mcpTrust = deps.mcpTrust ?? new PluginMcpTrustStore();
  }

  activate(pluginId: string): Promise<void> {
    return this.serialize(pluginId, () => this.activateNow(pluginId));
  }

  deactivate(pluginId: string): Promise<void> {
    return this.serialize(pluginId, () => this.deactivateNow(pluginId));
  }

  getActive(pluginId: string): ActivePluginGeneration<BundleGenerationState> | undefined {
    return this.coordinator.getActive(pluginId);
  }

  async approveHook(pluginId: string, localId: string): Promise<void> {
    const generation = this.requireActive(pluginId);
    const projection = generation.state.hooks.find((entry) => entry.owner.localId === localId);
    if (!projection) throw new Error(`plugin Hook '${pluginId}:${localId}' is not active`);
    this.hookTrust.approve(projection);
    this.deps.hookManager.publishPluginGeneration(generation.state.hooks, this.hookTrust);
  }

  async approveMcpServer(pluginId: string, localId: string): Promise<void> {
    const generation = this.requireActive(pluginId);
    const projection = generation.state.mcpServers.find((entry) => entry.owner.localId === localId);
    if (!projection) throw new Error(`plugin MCP '${pluginId}:${localId}' is not active`);
    this.mcpTrust.approve(projection);
    await this.deps.mcpManager.connectBundledServer(projection, this.mcpTrust);
  }

  private requireActive(pluginId: string): ActivePluginGeneration<BundleGenerationState> {
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
    const manifest = this.deps.pluginRuntime.getPluginManifest(pluginId);
    const pluginRoot = this.deps.pluginRuntime.getPluginRoot(pluginId);
    if (!manifest || !pluginRoot) throw new Error(`plugin '${pluginId}' is not loaded`);
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"));
    const receiptRaw = await readFile(installReceiptPath(this.deps.receiptCacheRoot, pluginId));
    const contributions = await materializePluginContributions(pluginRoot, manifest);
    const generationId = createHash("sha256").update(manifestRaw).update("\0").update(receiptRaw).digest("hex");
    const identity = {
      pluginId,
      pluginVersion: manifest.version,
      generationId,
      manifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
      receiptSha256: createHash("sha256").update(receiptRaw).digest("hex"),
      contributions,
    };
    const preparationView: ActivePluginGeneration = { ...identity, state: undefined };
    const candidate: ActivePluginGeneration<BundleGenerationState> = {
      ...identity,
      state: Object.freeze({
        hooks: preparePluginHookGeneration(preparationView),
        mcpServers: preparePluginMcpGeneration(preparationView),
      }),
    };

    await this.coordinator.commit(
      candidate,
      async () => {
        // Candidate parsing is complete. These synchronous map swaps contain no
        // provider work and keep unapproved executable contributions absent.
        this.deps.skillStore.publishPluginGeneration(candidate);
        this.deps.hookManager.publishPluginGeneration(candidate.state.hooks, this.hookTrust);
      },
      (predecessor) => this.retire(predecessor),
    );
    for (const projection of candidate.state.mcpServers) {
      await this.deps.mcpManager.connectBundledServer(projection, this.mcpTrust);
    }
  }

  private async deactivateNow(pluginId: string): Promise<void> {
    await this.coordinator.commit(
      undefined,
      async () => {
        this.deps.skillStore.removePlugin(pluginId);
        this.deps.hookManager.removePlugin(pluginId);
      },
      (predecessor) => this.retire(predecessor),
      pluginId,
    );
  }

  private async retire(generation: ActivePluginGeneration<BundleGenerationState>): Promise<void> {
    this.deps.skillOverlay.clearPluginGeneration(generation.pluginId, generation.generationId);
    await this.deps.mcpManager.disconnectBundledGeneration(generation.pluginId, generation.generationId);
  }
}
