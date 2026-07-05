/**
 * Bundle registry — single source of truth for all shipped theme bundles.
 *
 * Import from here to avoid deep path coupling:
 *   `import { BUNDLES, findBundle } from "../theme/bundles/index.js"`
 */
import type { ThemeBundle } from "./types.js";
import type { BundleId } from "../../../../shared/theme-bundles.js";
import { moonstoneBundle } from "./moonstone.js";
import { galleryBundle } from "./gallery.js";
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
import { executiveGraphiteBundle } from "./executive-graphite.js";
import {
  DEFAULT_BUNDLE_ID as _SHARED_DEFAULT_BUNDLE_ID,
  DEFAULT_VISIBLE_THEME_BUNDLE_IDS,
  MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS,
} from "../../../../shared/theme-bundles.js";

export type { ThemeBundle, BundleTokens } from "./types.js";
// §C3: re-export shared bundle IDs so renderer callers can import from this single registry path.
export {
  BUNDLE_IDS,
  DEFAULT_VISIBLE_THEME_BUNDLE_IDS,
  MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS,
} from "../../../../shared/theme-bundles.js";

// §C3: compile-time guard — `satisfies readonly ThemeBundle[]` ensures each entry's id is a
// valid BundleId (ThemeBundle.id is typed as BundleId). TypeScript errors here if any bundle
// uses an id not declared in theme-bundles.ts. No runtime guard needed.
/** Ordered list of all built-in bundles (display order in AppearanceTab). */
export const BUNDLES = [
  moonstoneBundle,
  galleryBundle,
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
  executiveGraphiteBundle,
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

function requireBundle(id: BundleId): ThemeBundle {
  const bundle = findBundle(id);
  if (!bundle) throw new Error(`Missing theme bundle metadata: ${id}`);
  return bundle;
}

export const DEFAULT_VISIBLE_BUNDLES = DEFAULT_VISIBLE_THEME_BUNDLE_IDS.map(
  requireBundle,
);

export const MARKETPLACE_THEME_BUNDLES = MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS.map(
  requireBundle,
);

export function visibleBundlesFor(currentBundleIds: readonly string[] = []): ThemeBundle[] {
  const visible = [...DEFAULT_VISIBLE_BUNDLES];
  for (const bundleId of currentBundleIds) {
    const bundle = findBundle(bundleId);
    if (!bundle) continue;
    if (visible.some((candidate) => candidate.id === bundle.id)) continue;
    visible.push(bundle);
  }
  return visible;
}
