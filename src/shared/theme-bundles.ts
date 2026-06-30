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

export const DEFAULT_BUNDLE_ID: BundleId = "cherry-blossom";
