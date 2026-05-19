/**
 * Bundle registry — single source of truth for all shipped theme bundles.
 *
 * Import from here to avoid deep path coupling:
 *   `import { BUNDLES, findBundle } from "../theme/bundles/index.js"`
 */
import type { ThemeBundle } from "./types.js";
import type { BundleId } from "../../../../shared/theme-bundles.js";
import { cherryBlossomBundle } from "./cherry-blossom.js";
import { tokyoNightBundle } from "./tokyo-night.js";
import { midnightBundle } from "./midnight.js";
import { forestBundle } from "./forest.js";
import { violetLightBundle } from "./violet-light.js";
import { violetDarkBundle } from "./violet-dark.js";
import { highContrastBundle } from "./high-contrast.js";
import { catppuccinMochaBundle } from "./catppuccin-mocha.js";
import { catppuccinLatteBundle } from "./catppuccin-latte.js";
import { nordBundle } from "./nord.js";
import { gruvboxDarkHardBundle } from "./gruvbox-dark-hard.js";
import { solarizedLightBundle } from "./solarized-light.js";
import { rosePineBundle } from "./rose-pine.js";
import { DEFAULT_BUNDLE_ID as _SHARED_DEFAULT_BUNDLE_ID } from "../../../../shared/theme-bundles.js";

export type { ThemeBundle, BundleTokens } from "./types.js";
// §C3: re-export shared bundle IDs so renderer callers can import from this single registry path.
export { BUNDLE_IDS } from "../../../../shared/theme-bundles.js";

// §C3: compile-time guard — `satisfies readonly ThemeBundle[]` ensures each entry's id is a
// valid BundleId (ThemeBundle.id is typed as BundleId). TypeScript errors here if any bundle
// uses an id not declared in theme-bundles.ts. No runtime guard needed.
/** Ordered list of all built-in bundles (display order in AppearanceTab). */
export const BUNDLES = [
  cherryBlossomBundle,
  tokyoNightBundle,
  midnightBundle,
  forestBundle,
  violetLightBundle,
  violetDarkBundle,
  catppuccinMochaBundle,
  catppuccinLatteBundle,
  nordBundle,
  gruvboxDarkHardBundle,
  solarizedLightBundle,
  rosePineBundle,
  highContrastBundle,
] as const satisfies readonly ThemeBundle[];

// §C3 (continued): cross-direction compile-time guard. `satisfies` only proves
// every BUNDLES entry's id is a valid BundleId. This dummy assignment also
// proves the reverse — every BundleId in BUNDLE_IDS has a BUNDLES entry. If
// someone adds a new id to BUNDLE_IDS without registering the bundle here,
// `BundleId` will contain a literal that `BUNDLES[number]["id"]` does not, and
// the assignment fails at compile time. The variable is `void`'d so emit is
// erased and there is no runtime cost.
type _BundleIdCoverage = (typeof BUNDLES)[number]["id"];
const _bundleIdCoverageCheck: BundleId extends _BundleIdCoverage ? true : never = true;
void _bundleIdCoverageCheck;

/** Default bundle applied on fresh installs. §C3: sourced from shared/theme-bundles.ts. */
export const DEFAULT_BUNDLE_ID = _SHARED_DEFAULT_BUNDLE_ID;

/**
 * Find a bundle by id. Returns `undefined` for unknown ids — callers should
 * fall back to `findBundle(DEFAULT_BUNDLE_ID)!` in that case.
 */
export function findBundle(id: string): ThemeBundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}
