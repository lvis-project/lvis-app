import type { PluginPaths } from "./plugin-paths.js";
import { recoverPendingPluginUpdates } from "./marketplace-update-recovery.js";
import { reconcileRemovalTransactions } from "./plugin-removal-transaction.js";
import { migratePluginRegistry } from "./registry.js";

/** Persist supported legacy rows before any recovery or runtime discovery. */
export async function preparePluginRegistryForBoot(paths: PluginPaths): Promise<{
  recovered: string[];
  unresolved: string[];
}> {
  await migratePluginRegistry(paths.registryPath);
  await reconcileRemovalTransactions(paths);
  return recoverPendingPluginUpdates(paths);
}
