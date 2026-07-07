/**
 * Bundle registry.
 *
 * Core renderer startup imports only the default-visible theme bundles. Theme
 * token payloads moved to Marketplace are loaded on demand so long-tail theme
 * packages stop inflating the initial renderer chunk.
 */
import { t } from "../../../../i18n/runtime.js";
import type { ThemeBundle } from "./types.js";
import type {
  BundleId,
  MarketplaceEligibleThemeBundleId,
} from "../../../../shared/theme-bundles.js";
import { moonstoneBundle } from "./moonstone.js";
import { galleryBundle } from "./gallery.js";
import {
  DEFAULT_BUNDLE_ID as _SHARED_DEFAULT_BUNDLE_ID,
  DEFAULT_VISIBLE_THEME_BUNDLE_IDS,
  MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS,
  isBundleId,
} from "../../../../shared/theme-bundles.js";

export type { ThemeBundle, BundleTokens } from "./types.js";
export type ThemeBundleManifest = Omit<ThemeBundle, "tokens">;

export {
  BUNDLE_IDS,
  DEFAULT_VISIBLE_THEME_BUNDLE_IDS,
  MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS,
  isBundleId,
} from "../../../../shared/theme-bundles.js";

const DEFAULT_BUNDLE_BY_ID = Object.freeze({
  moonstone: moonstoneBundle,
  gallery: galleryBundle,
} satisfies Record<(typeof DEFAULT_VISIBLE_THEME_BUNDLE_IDS)[number], ThemeBundle>);

export const DEFAULT_VISIBLE_BUNDLES = DEFAULT_VISIBLE_THEME_BUNDLE_IDS.map(
  (id) => DEFAULT_BUNDLE_BY_ID[id],
);

/**
 * Back-compatible name for callers that need already-loaded core bundles.
 * Marketplace bundle tokens are intentionally not part of this array.
 */
export const BUNDLES = DEFAULT_VISIBLE_BUNDLES;

export const MARKETPLACE_THEME_BUNDLE_MANIFESTS = Object.freeze({
  "cherry-blossom": {
    id: "cherry-blossom",
    name: "Cherry Blossom",
    description: t("cherryBlossom.description"),
    shell: "light",
    highContrast: false,
  },
  "tokyo-night": {
    id: "tokyo-night",
    name: "Tokyo Night",
    description: t("tokyoNight.description"),
    shell: "dark",
    highContrast: false,
  },
  midnight: {
    id: "midnight",
    name: "Midnight",
    description: t("midnight.description"),
    shell: "dark",
    highContrast: false,
  },
  forest: {
    id: "forest",
    name: "Forest",
    description: t("forest.description"),
    shell: "light",
    highContrast: false,
  },
  "violet-light": {
    id: "violet-light",
    name: "Violet Light",
    description: t("violetLight.description"),
    shell: "light",
    highContrast: false,
  },
  "violet-dark": {
    id: "violet-dark",
    name: "Violet Dark",
    description: t("violetDark.description"),
    shell: "dark",
    highContrast: false,
  },
  "high-contrast": {
    id: "high-contrast",
    name: "High Contrast",
    description: t("highContrast.description"),
    shell: "dark",
    highContrast: true,
  },
  "catppuccin-mocha": {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    description: t("catppuccinMocha.description"),
    shell: "dark",
    highContrast: false,
  },
  "catppuccin-latte": {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    description: t("catppuccinLatte.description"),
    shell: "light",
    highContrast: false,
  },
  nord: {
    id: "nord",
    name: "Nord",
    description: t("nord.description"),
    shell: "dark",
    highContrast: false,
  },
  "gruvbox-dark-hard": {
    id: "gruvbox-dark-hard",
    name: "Gruvbox Dark Hard",
    description: t("gruvboxDarkHard.description"),
    shell: "dark",
    highContrast: false,
  },
  "solarized-light": {
    id: "solarized-light",
    name: "Solarized Light",
    description: t("solarizedLight.description"),
    shell: "light",
    highContrast: false,
  },
  "rose-pine": {
    id: "rose-pine",
    name: "Rosé Pine",
    description: t("rosePine.description"),
    shell: "dark",
    highContrast: false,
  },
  "executive-graphite": {
    id: "executive-graphite",
    name: "Executive Graphite",
    description: t("executiveGraphite.description"),
    shell: "dark",
    highContrast: false,
  },
} satisfies Record<MarketplaceEligibleThemeBundleId, ThemeBundleManifest>);

export const MARKETPLACE_THEME_BUNDLES = MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS.map(
  (id) => MARKETPLACE_THEME_BUNDLE_MANIFESTS[id],
);

const loadedBundleCache = new Map<BundleId, ThemeBundle>(
  DEFAULT_VISIBLE_BUNDLES.map((bundle) => [bundle.id, bundle]),
);

type MarketplaceThemeBundleLoader = () => Promise<ThemeBundle>;

const MARKETPLACE_THEME_BUNDLE_LOADERS = Object.freeze({
  "cherry-blossom": async () => (await import("./cherry-blossom.js")).cherryBlossomBundle,
  "tokyo-night": async () => (await import("./tokyo-night.js")).tokyoNightBundle,
  midnight: async () => (await import("./midnight.js")).midnightBundle,
  forest: async () => (await import("./forest.js")).forestBundle,
  "violet-light": async () => (await import("./violet-light.js")).violetLightBundle,
  "violet-dark": async () => (await import("./violet-dark.js")).violetDarkBundle,
  "high-contrast": async () => (await import("./high-contrast.js")).highContrastBundle,
  "catppuccin-mocha": async () => (await import("./catppuccin-mocha.js")).catppuccinMochaBundle,
  "catppuccin-latte": async () => (await import("./catppuccin-latte.js")).catppuccinLatteBundle,
  nord: async () => (await import("./nord.js")).nordBundle,
  "gruvbox-dark-hard": async () => (await import("./gruvbox-dark-hard.js")).gruvboxDarkHardBundle,
  "solarized-light": async () => (await import("./solarized-light.js")).solarizedLightBundle,
  "rose-pine": async () => (await import("./rose-pine.js")).rosePineBundle,
  "executive-graphite": async () => (await import("./executive-graphite.js")).executiveGraphiteBundle,
} satisfies Record<MarketplaceEligibleThemeBundleId, MarketplaceThemeBundleLoader>);

const themeBundleLoaderOverridesForTests =
  new Map<MarketplaceEligibleThemeBundleId, MarketplaceThemeBundleLoader>();

export const DEFAULT_BUNDLE_ID = _SHARED_DEFAULT_BUNDLE_ID;

export function findBundle(id: string): ThemeBundle | undefined {
  return isBundleId(id) ? loadedBundleCache.get(id) : undefined;
}

export async function loadThemeBundle(id: string): Promise<ThemeBundle | undefined> {
  if (!isBundleId(id)) return undefined;
  const cached = loadedBundleCache.get(id);
  if (cached) return cached;
  const marketplaceId = id as MarketplaceEligibleThemeBundleId;
  const loader = themeBundleLoaderOverridesForTests.get(marketplaceId)
    ?? MARKETPLACE_THEME_BUNDLE_LOADERS[marketplaceId];
  if (!loader) return undefined;
  const bundle = await loader();
  loadedBundleCache.set(bundle.id, bundle);
  return bundle;
}

export async function loadThemeBundles(ids: readonly string[]): Promise<ThemeBundle[]> {
  const bundles = await Promise.all(ids.map((id) => loadThemeBundle(id)));
  const visible: ThemeBundle[] = [];
  for (const bundle of bundles) {
    if (!bundle || visible.some((candidate) => candidate.id === bundle.id)) continue;
    visible.push(bundle);
  }
  return visible;
}

export async function loadAllThemeBundles(): Promise<ThemeBundle[]> {
  return loadThemeBundles([...DEFAULT_VISIBLE_THEME_BUNDLE_IDS, ...MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS]);
}

export function visibleBundlesFor(
  currentBundleIds: readonly string[] = [],
  loadedBundles: readonly ThemeBundle[] = [],
): ThemeBundle[] {
  const visible: ThemeBundle[] = [...DEFAULT_VISIBLE_BUNDLES];
  for (const bundle of loadedBundles) {
    if (visible.some((candidate) => candidate.id === bundle.id)) continue;
    visible.push(bundle);
  }
  for (const bundleId of currentBundleIds) {
    const bundle = findBundle(bundleId);
    if (!bundle) continue;
    if (visible.some((candidate) => candidate.id === bundle.id)) continue;
    visible.push(bundle);
  }
  return visible;
}

/** @internal test-only reset for cold-cache lazy-load coverage. */
export function resetLoadedThemeBundleCacheForTests(): void {
  loadedBundleCache.clear();
  for (const bundle of DEFAULT_VISIBLE_BUNDLES) {
    loadedBundleCache.set(bundle.id, bundle);
  }
  themeBundleLoaderOverridesForTests.clear();
}

/** @internal test-only loader override for lazy chunk failure coverage. */
export function setThemeBundleLoaderOverrideForTests(
  id: MarketplaceEligibleThemeBundleId,
  loader: MarketplaceThemeBundleLoader | null,
): void {
  loadedBundleCache.delete(id);
  if (loader) {
    themeBundleLoaderOverridesForTests.set(id, loader);
  } else {
    themeBundleLoaderOverridesForTests.delete(id);
  }
}
