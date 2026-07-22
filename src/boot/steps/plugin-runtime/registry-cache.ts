/**
 * Boot §4.2 / #958-#959 — registry-entry cache (C6 extraction).
 *
 * Behavior-preserving move of the `registryEntryCache` cluster out of
 * initPluginRuntime. The registry file (`~/.lvis/plugins/registry.json`) is the
 * host-verified source of truth for admin/user `installSource` and the
 * install-time manifest SHA pin; `plugin.json` lives inside the plugin's
 * writable surface and cannot be trusted alone. The cache is populated at boot
 * and refreshed on every install/uninstall so HostApi closures answer lookups
 * synchronously without touching disk on the hot path.
 *
 * Trust source: caller code (getSecret / resolveApiKey) reads this map;
 * manifest-only admin metadata cannot activate secret-access bypass.
 */
import { readPluginRegistry } from "../../../plugins/registry.js";
import type { PluginRegistryEntry } from "../../../plugins/types.js";

export interface RegistryEntryCache {
  refreshRegistryEntryCache: () => Promise<void>;
  getRegistryEntry: (
    pluginId: string,
  ) => Pick<PluginRegistryEntry, "installSource" | "manifestSha256"> | undefined;
}

/**
 * Build the registry-entry cache. `refreshRegistryEntryCache` re-reads the
 * host-managed registry file (fail-closed on error → empty cache → callers
 * treat missing installSource as "user"); `getRegistryEntry` is a synchronous
 * lookup used inside the per-plugin HostApi closures.
 */
export function createRegistryEntryCache(deps: {
  registryPath: string;
  log: { warn: (msg: string, ...args: unknown[]) => void };
}): RegistryEntryCache {
  const { registryPath, log } = deps;
  const registryEntryCache = new Map<string, Pick<PluginRegistryEntry, "installSource" | "manifestSha256">>();
  const refreshRegistryEntryCache = async (): Promise<void> => {
    try {
      const registry = await readPluginRegistry(registryPath);
      registryEntryCache.clear();
      for (const entry of registry.plugins) {
        if (entry.pendingUpdate) continue;
        if (entry.installSource !== undefined || entry.manifestSha256 !== undefined) {
          registryEntryCache.set(entry.id, {
            installSource: entry.installSource,
            manifestSha256: entry.manifestSha256,
          });
        }
      }
    } catch (err) {
      registryEntryCache.clear();
      // Cache stays empty. Secret-access bypass stays fail-closed
      // because callers treat a missing registry installSource as "user".
      log.warn(
        "registry-entry cache refresh failed: %s",
        (err as Error).message,
      );
    }
  };
  const getRegistryEntry = (
    pluginId: string,
  ): Pick<PluginRegistryEntry, "installSource" | "manifestSha256"> | undefined => registryEntryCache.get(pluginId);
  return { refreshRegistryEntryCache, getRegistryEntry };
}
