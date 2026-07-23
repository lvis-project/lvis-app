import type {
  PluginAccessSpec,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
} from "./types.js";
import type { PreparedPluginHookProjection } from "../hooks/plugin-hook-projection.js";
import type { PreparedPluginMcpProjection } from "../mcp/plugin-mcp-projection.js";
import type {
  ActivePluginGeneration,
  PluginGenerationLease,
} from "./plugin-generation-coordinator.js";
import type { HostApiGenerationScope } from "./plugin-host-effect-scope.js";

export interface PluginRuntimeGenerationProjection {
  readonly manifest: PluginManifest;
  readonly pluginRoot: string;
  readonly instance: RuntimePlugin;
  readonly methods: ReadonlyMap<string, PluginToolHandler>;
  readonly approvedPluginAccess?: PluginAccessSpec;
  readonly disposers?: readonly (() => void)[];
  readonly hostEffects?: HostApiGenerationScope;
}

/** Immutable Host view shared by runtime, Skill, Hook, MCP and operation policy. */
export interface HostPluginGenerationState {
  readonly payloadRoot: string;
  readonly runtime: PluginRuntimeGenerationProjection;
  readonly hooks: readonly PreparedPluginHookProjection[];
  readonly mcpServers: readonly PreparedPluginMcpProjection[];
}

export interface PluginRuntimeGenerationAccess {
  getActive(pluginId: string): ActivePluginGeneration<HostPluginGenerationState> | undefined;
  acquire(pluginId: string): Promise<PluginGenerationLease<HostPluginGenerationState>>;
  acquireExact(pluginId: string, generationId: string): Promise<PluginGenerationLease<HostPluginGenerationState>>;
}

export interface PluginRuntimeGenerationLifecycle extends PluginRuntimeGenerationAccess {
  replaceRuntime(runtime: PluginRuntimeGenerationProjection): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
  deactivateWithCommit<T>(pluginId: string, durableCommit: () => Promise<T>): Promise<T>;
  setContributionsEnabled(pluginId: string, enabled: boolean): Promise<void>;
  recoverRetirements(): Promise<void>;
  waitForRetirements(): Promise<void>;
}
