/**
 * Theme system v2 barrel.
 *
 * Components import from here to avoid deep paths:
 *   `import { useTheme } from "../theme/index.js"`
 */
export { ThemeProvider, useTheme, useOptionalTheme } from "./ThemeProvider.js";
export { applyBundleToDocument, resolveSystemPair, bundleShell } from "./resolve-theme.js";
export { bundleToPluginTokens } from "./plugin-token-map.js";
export {
  BUNDLES,
  DEFAULT_BUNDLE_ID,
  findBundle,
} from "./bundles/index.js";
export type { ThemeBundle, BundleTokens } from "./bundles/index.js";
export type {
  ThemeContextValue,
  BundleId,
  ResolvedShell,
} from "./types.js";
export { VIOLET_PAIR_IDS } from "./types.js";
