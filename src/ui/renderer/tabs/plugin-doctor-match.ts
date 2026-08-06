import { normalizePluginLookupKey } from "../../../shared/plugin-lookup-key.js";
import type { MarketplaceItem, PluginCardSummary } from "../types.js";

/**
 * Plugin Doctor "repair" target resolution.
 *
 * Extracted from `PluginConfigTab.tsx` so the derivation that picks which
 * catalog package a repair reinstalls is unit-testable: its result is handed
 * straight to `installMarketplacePlugin`, and it shares its comparison key
 * with the main-process catalog matcher (`shared/plugin-lookup-key.ts`).
 */

/** Install key to use when no catalog item matches. */
export function getPluginDoctorInstallKey(plugin: PluginCardSummary): string {
  return plugin.installAliases?.[0] ?? plugin.id;
}

/** The catalog item this installed plugin came from, or `null`. */
export function findPluginDoctorMarketplaceItem(
  plugin: PluginCardSummary,
  marketplace: MarketplaceItem[],
): MarketplaceItem | null {
  const literalKeys = new Set(
    [plugin.id, ...(plugin.installAliases ?? [])]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const normalizedKeys = new Set(
    [plugin.id, plugin.name, ...(plugin.installAliases ?? [])]
      .map((value) => normalizePluginLookupKey(value))
      .filter(Boolean),
  );

  return marketplace.find((item) => {
    if (item.pluginType && item.pluginType !== "plugin") return false;
    if (literalKeys.has(item.id.trim().toLowerCase())) return true;
    return [item.id, item.name, item.packageSpec].some((value) =>
      normalizedKeys.has(normalizePluginLookupKey(value)),
    );
  }) ?? null;
}
