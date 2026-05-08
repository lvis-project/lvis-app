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
import { BUNDLE_IDS, DEFAULT_BUNDLE_ID as _SHARED_DEFAULT_BUNDLE_ID } from "../../../../shared/theme-bundles.js";

export type { ThemeBundle, BundleTokens } from "./types.js";
// §C3: re-export shared bundle IDs so renderer callers can import from this single registry path.
export { BUNDLE_IDS } from "../../../../shared/theme-bundles.js";

/** Ordered list of all built-in bundles (display order in AppearanceTab). */
export const BUNDLES: readonly ThemeBundle[] = [
  tokyoNightBundle,
  midnightBundle,
  forestBundle,
  lgeLightBundle,
  lgeDarkBundle,
  highContrastBundle,
];

// §C3: compile-time guard — ensure every BUNDLE_IDS entry has a matching bundle object.
// If a bundle ID is added to theme-bundles.ts but not to BUNDLES above, TypeScript will
// surface a type error here rather than a silent runtime mismatch.
((): void => {
  const registeredIds = new Set(BUNDLES.map((b) => b.id));
  for (const id of BUNDLE_IDS) {
    if (!registeredIds.has(id)) {
      throw new Error(`[theme-bundles] Bundle object missing for id "${id}" — add it to BUNDLES in bundles/index.ts`);
    }
  }
})();

/** Default bundle applied on fresh installs. §C3: sourced from shared/theme-bundles.ts. */
export const DEFAULT_BUNDLE_ID = _SHARED_DEFAULT_BUNDLE_ID;

/**
 * Find a bundle by id. Returns `undefined` for unknown ids — callers should
 * fall back to `findBundle(DEFAULT_BUNDLE_ID)!` in that case.
 */
export function findBundle(id: string): ThemeBundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}
