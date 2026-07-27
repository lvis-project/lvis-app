import type {
  CommittedPluginGeneration,
  PluginRuntimeGenerationLifecycle,
  PluginRuntimeGenerationProjection,
} from "../plugin-host-generation.js";

export type CapabilityDependencyCommitScope = <T>(
  operation: () => Promise<T>,
) => Promise<T>;

export interface CapabilityBlockedReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export interface CapabilityBlockedRetry {
  readonly retry: () => Promise<void>;
  readonly isCurrent: () => boolean;
  readonly readiness: CapabilityBlockedReadiness;
  readonly waitingForOwnPreparation?: boolean;
}

/** Internal extension implemented by PluginBundleLifecycle, never public API. */
export interface CapabilityCommitScopedGenerationLifecycle
  extends PluginRuntimeGenerationLifecycle {
  replaceRuntime(
    runtime: PluginRuntimeGenerationProjection,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<void>;
  replaceRuntimeWithCommit<T>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRaw: string,
    durableCommit: () => Promise<T>,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<CommittedPluginGeneration<T>>;
  deactivateWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
    commitScope?: CapabilityDependencyCommitScope,
  ): Promise<CommittedPluginGeneration<T>>;
}
