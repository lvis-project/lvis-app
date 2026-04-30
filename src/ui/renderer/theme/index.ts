/**
 * UX Track 3 — theme system barrel.
 *
 * Components import from here to avoid deep paths:
 *   `import { useTheme } from "../theme/index.js"`
 */
export { ThemeProvider, useTheme, useOptionalTheme } from "./ThemeProvider.js";
export { resolveTheme, applyThemeToDocument } from "./resolve-theme.js";
export { THEME_PREFERENCES } from "./types.js";
export type { ThemeContextValue, ThemePreference, ResolvedTheme } from "./types.js";
