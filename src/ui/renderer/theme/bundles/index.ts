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
import { DEFAULT_BUNDLE_ID as _SHARED_DEFAULT_BUNDLE_ID } from "../../../../shared/theme-bundles.js";

export type { ThemeBundle, BundleTokens } from "./types.js";
// §C3: re-export shared bundle IDs so renderer callers can import from this single registry path.
export { BUNDLE_IDS } from "../../../../shared/theme-bundles.js";

// §C3: compile-time guard — `satisfies readonly ThemeBundle[]` ensures each entry's id is a
// valid BundleId (ThemeBundle.id is typed as BundleId). TypeScript errors here if any bundle
// uses an id not declared in theme-bundles.ts. No runtime guard needed.
/** Ordered list of all built-in bundles (display order in AppearanceTab). */
export const BUNDLES = [
  tokyoNightBundle,
  midnightBundle,
  forestBundle,
  lgeLightBundle,
  lgeDarkBundle,
  highContrastBundle,
] as const satisfies readonly ThemeBundle[];

/** Default bundle applied on fresh installs. §C3: sourced from shared/theme-bundles.ts. */
export const DEFAULT_BUNDLE_ID = _SHARED_DEFAULT_BUNDLE_ID;

/**
 * Find a bundle by id. Returns `undefined` for unknown ids — callers should
 * fall back to `findBundle(DEFAULT_BUNDLE_ID)!` in that case.
 */
export function findBundle(id: string): ThemeBundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}
