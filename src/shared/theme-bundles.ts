/**
 * §C3 (M1): Single source of truth for all valid bundle IDs.
 *
 * Previously three independent hard-coded lists existed:
 *   - `src/ui/renderer/theme/bundles/index.ts`  (BUNDLES array)
 *   - `src/data/settings-store.ts`               (VALID_BUNDLE_IDS)
 *   - `src/ipc/domains/plugins.ts`               (ALLOWED_BUNDLE_IDS)
 *
 * Any drift between these three would allow an unknown bundleId through one
 * gate while being rejected by another. Centralizing here closes that gap.
 *
 * NOTE: This module is imported by both the main process (settings-store,
 * plugins IPC) and the renderer process (theme/bundles/index). Keep it
 * free of process-specific imports (electron, node:fs, etc.).
 */

export const BUNDLE_IDS = [
  "moonstone",
  "gallery",
  "cherry-blossom",
  "tokyo-night",
  "midnight",
  "forest",
  "violet-light",
  "violet-dark",
  "high-contrast",
  "catppuccin-mocha",
  "catppuccin-latte",
  "nord",
  "gruvbox-dark-hard",
  "solarized-light",
  "rose-pine",
  "executive-graphite",
] as const;

export type BundleId = (typeof BUNDLE_IDS)[number];

export const DEFAULT_BUNDLE_ID: BundleId = "moonstone";

/**
 * Themes shown in the default in-app appearance picker while older/community
 * themes move toward marketplace packages. The full `BUNDLE_IDS` union remains
 * broad for settings migration, plugin theme events, and backward-compatible
 * validation during the marketplace migration.
 */
export const DEFAULT_VISIBLE_THEME_BUNDLE_IDS = [
  "moonstone",
  "gallery",
] as const satisfies readonly BundleId[];

export type DefaultVisibleThemeBundleId =
  (typeof DEFAULT_VISIBLE_THEME_BUNDLE_IDS)[number];

const DEFAULT_VISIBLE_THEME_BUNDLE_ID_SET = new Set<string>(
  DEFAULT_VISIBLE_THEME_BUNDLE_IDS,
);

export type MarketplaceEligibleThemeBundleId =
  Exclude<BundleId, DefaultVisibleThemeBundleId>;

export const MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS = BUNDLE_IDS.filter(
  (bundleId): bundleId is MarketplaceEligibleThemeBundleId =>
    !DEFAULT_VISIBLE_THEME_BUNDLE_ID_SET.has(bundleId),
);

export function isDefaultVisibleThemeBundleId(
  bundleId: unknown,
): bundleId is DefaultVisibleThemeBundleId {
  return (
    typeof bundleId === "string" &&
    DEFAULT_VISIBLE_THEME_BUNDLE_ID_SET.has(bundleId)
  );
}
