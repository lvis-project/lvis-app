import type { CommittedPluginGeneration } from "../plugin-host-generation.js";

interface AtomicPluginRemovalOptions<T> {
  requestedPluginId: string;
  loaded: boolean;
  known: boolean;
  hasActiveGeneration(): boolean;
  durableCommit(): Promise<T>;
  deactivateWithCommit(): Promise<CommittedPluginGeneration<T>>;
  captureRetirementFailure(retirement: Promise<void>): Promise<unknown>;
  purgeRuntimeState(): Promise<void>;
}

/**
 * Commit the durable registry removal before purging Host runtime state.
 *
 * Once deactivation publishes the inactive generation pointer, retirement
 * failure is reported only after the remaining runtime tracking has been
 * purged. This keeps the durable marketplace commit and Host projection
 * monotonic even when a retired plugin's stop hook fails.
 */
export async function commitAtomicPluginRemoval<T>(
  options: AtomicPluginRemovalOptions<T>,
): Promise<T> {
  if (!options.known) {
    throw new Error(
      `cannot atomically remove unknown plugin: ${options.requestedPluginId}`,
    );
  }

  let result: T;
  let retirementError: unknown;
  if (options.loaded) {
    const committed = await options.deactivateWithCommit();
    result = committed.result;
    retirementError = await options.captureRetirementFailure(
      committed.retirement,
    );
  } else {
    if (options.hasActiveGeneration()) {
      throw new Error(
        `atomic plugin removal found active generation without loaded runtime: ${options.requestedPluginId}`,
      );
    }
    result = await options.durableCommit();
  }

  await options.purgeRuntimeState();
  if (retirementError !== undefined) throw retirementError;
  return result;
}
