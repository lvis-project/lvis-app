import type { PluginPaths } from "./plugin-paths.js";
import { recoverPendingPluginUpdates } from "./marketplace-update-recovery.js";
import {
  reconcileRemovalTransactions,
  type ReconcileOptions,
  type RemovalTransactionReconciliationResult,
} from "./plugin-removal-transaction.js";
import { migratePluginRegistry } from "./registry.js";

export interface PluginBootRecoveryResult {
  recovered: string[];
  unresolved: string[];
  removals: RemovalTransactionReconciliationResult;
  pendingRecoverySkipped: boolean;
}

/** Persist supported legacy rows before any recovery or runtime discovery. */
export async function preparePluginRegistryForBoot(
  paths: PluginPaths,
  options: { removalReconcile?: ReconcileOptions } = {},
): Promise<PluginBootRecoveryResult> {
  await migratePluginRegistry(paths.registryPath);
  const removals = await reconcileRemovalTransactions(paths, options.removalReconcile);
  if (removals.unresolved.length > 0) {
    return { recovered: [], unresolved: [], removals, pendingRecoverySkipped: true };
  }
  const pending = await recoverPendingPluginUpdates(paths);
  return { ...pending, removals, pendingRecoverySkipped: false };
}
