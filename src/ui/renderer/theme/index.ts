/**
 * UX Track 3 — theme system barrel.
 *
 * Components import from here to avoid deep paths:
 *   `import { useTheme } from "../theme/index.js"`
 */
export { ThemeProvider, useTheme, useOptionalTheme } from "./ThemeProvider.js";
export {
  resolveTheme,
  resolveCodeTheme,
  applyThemeToDocument,
  applyChatThemeToDocument,
  applyCodeThemeToDocument,
} from "./resolve-theme.js";
export {
  THEME_PREFERENCES,
  CHAT_THEME_PREFERENCES,
  CODE_THEME_PREFERENCES,
} from "./types.js";
export type {
  ThemeContextValue,
  ThemePreference,
  ResolvedTheme,
  ChatThemePreference,
  CodeThemePreference,
  ResolvedCodeTheme,
} from "./types.js";
