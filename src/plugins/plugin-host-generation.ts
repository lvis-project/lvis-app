import type {
  PluginAccessSpec,
  PluginManifest,
  PluginToolHandler,
  RuntimePlugin,
} from "./types.js";
import type { PreparedPluginHookProjection } from "../hooks/plugin-hook-projection.js";
import type { PreparedPluginMcpProjection } from "../mcp/plugin-mcp-projection.js";
import type { PluginGenerationLease } from "./plugin-generation-coordinator.js";
import type { HostApiGenerationScope } from "./plugin-host-effect-scope.js";

type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T
    : T extends readonly (infer TItem)[] ? readonly DeepReadonly<TItem>[]
      : T extends object ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
        : T;

export interface ActivePluginGenerationSnapshot {
  readonly pluginId: string;
  readonly generationId: string;
  readonly manifest: DeepReadonly<PluginManifest>;
}

export interface PluginRuntimeGenerationProjection {
  readonly activationId: string;
  readonly manifest: PluginManifest;
  readonly pluginRoot: string;
  readonly instance: RuntimePlugin;
  readonly methods: ReadonlyMap<string, PluginToolHandler>;
  readonly approvedPluginAccess?: PluginAccessSpec;
  readonly disposers?: readonly (() => void)[];
  readonly hostEffects?: HostApiGenerationScope;
  readonly deactivateHostApi?: () => void;
  readonly drainHostApiOperations?: () => Promise<void>;
  readonly lifecycleHookScope?: {
    active: boolean;
    depth: number;
  };
}

export interface PreparedPluginRuntimeGenerationPublication {
  readonly pluginId: string;
  publish(): void;
}

export interface CommittedPluginGeneration<T> {
  readonly result: T;
  /** Settles only after every predecessor lease drains and retirement finishes. */
  readonly retirement: Promise<void>;
}

/** Immutable Host view shared by runtime, Skill, Hook, MCP and operation policy. */
export interface HostPluginGenerationState {
  readonly payloadRoot: string;
  readonly runtime: PluginRuntimeGenerationProjection;
  readonly hooks: readonly PreparedPluginHookProjection[];
  readonly mcpServers: readonly PreparedPluginMcpProjection[];
}

export interface PluginRuntimeGenerationAccess {
  getActive(pluginId: string): ActivePluginGenerationSnapshot | undefined;
  acquire(pluginId: string): Promise<PluginGenerationLease<HostPluginGenerationState>>;
  acquireExact(pluginId: string, generationId: string): Promise<PluginGenerationLease<HostPluginGenerationState>>;
  runWithLease<T>(
    lease: PluginGenerationLease<HostPluginGenerationState>,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface PluginRuntimeGenerationLifecycle extends PluginRuntimeGenerationAccess {
  /**
   * Serialize a complete plugin lifecycle operation with generation
   * transitions for the same plugin. Nested lifecycle calls for `pluginId`
   * reuse the current queue slot.
   */
  runInLifecycleQueue<T>(pluginId: string, operation: () => Promise<T>): Promise<T>;
  replaceRuntime(runtime: PluginRuntimeGenerationProjection): Promise<void>;
  replaceRuntimeWithCommit<T>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRaw: string,
    durableCommit: () => Promise<T>,
  ): Promise<CommittedPluginGeneration<T>>;
  deactivate(pluginId: string): Promise<void>;
  deactivateWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
  ): Promise<CommittedPluginGeneration<T>>;
  recoverRetirements(): Promise<void>;
  waitForRetirements(): Promise<void>;
}
