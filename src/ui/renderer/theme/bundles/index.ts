/**
 * Bundle registry — single source of truth for all shipped theme bundles.
 *
 * Import from here to avoid deep path coupling:
 *   `import { BUNDLES, findBundle } from "../theme/bundles/index.js"`
 */
import type { ThemeBundle } from "./types.js";
import { tokyoNightBundle } from "./tokyo-night.js";
import { midnightBundle } from "./midnight.js";
import { forestBundle } from "./forest.js";
import { lgeLightBundle } from "./lge-light.js";
import { lgeDarkBundle } from "./lge-dark.js";
import { highContrastBundle } from "./high-contrast.js";

export type { ThemeBundle, BundleTokens } from "./types.js";

/** Ordered list of all built-in bundles (display order in AppearanceTab). */
export const BUNDLES: readonly ThemeBundle[] = [
  tokyoNightBundle,
  midnightBundle,
  forestBundle,
  lgeLightBundle,
  lgeDarkBundle,
  highContrastBundle,
];

/** Default bundle applied on fresh installs. */
export const DEFAULT_BUNDLE_ID = "tokyo-night";

/**
 * Find a bundle by id. Returns `undefined` for unknown ids — callers should
 * fall back to `findBundle(DEFAULT_BUNDLE_ID)!` in that case.
 */
export function findBundle(id: string): ThemeBundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}
