/**
 * UX Track 3 — theme system public types.
 *
 * Three independent axes are managed by ThemeProvider:
 *   1. ThemePreference     — global shell light/dark/high-contrast (`data-theme`)
 *   2. ChatThemePreference — accent color overlay (`data-chat-theme`)
 *   3. CodeThemePreference — code-block surface scheme (`data-code-theme`)
 *
 * Mirrors the unions in `src/data/settings-store.ts` so the renderer can
 * ship without importing main-process types directly. Keep these in sync.
 *
 * `Resolved*` types are what gets written to the <html> data-attributes:
 *   - "system" theme is resolved against `prefers-color-scheme`
 *   - "auto" codeTheme is resolved against the active resolved theme
 *   - chatTheme has no resolution step (preference IS the resolved value)
 */
export type ThemePreference = "system" | "light" | "dark" | "high-contrast";
export type ResolvedTheme = "light" | "dark" | "high-contrast";

export type ChatThemePreference = "default" | "lg" | "purple" | "orange" | "blue";

export type CodeThemePreference = "auto" | "light" | "dark";
export type ResolvedCodeTheme = "light" | "dark";

export interface ThemeContextValue {
  /** User-facing shell preference (light/dark/system/high-contrast). */
  preference: ThemePreference;
  /** Concrete shell theme actually applied to <html data-theme>. */
  resolved: ResolvedTheme;
  /** User-facing chat accent (default/purple/orange/blue). */
  chatTheme: ChatThemePreference;
  /** User-facing code-surface preference (auto/light/dark). */
  codeTheme: CodeThemePreference;
  /** Concrete code-surface scheme written to <html data-code-theme>. */
  resolvedCodeTheme: ResolvedCodeTheme;
  /**
   * Live-set the shell preference. Updates the DOM immediately and persists
   * to `~/.lvis/settings.json` via `api.updateSettings({ appearance: ... })`
   * if the provider was given an api.
   */
  setPreference: (next: ThemePreference) => void;
  /** Live-set the chat-accent preference. Same persistence semantics. */
  setChatTheme: (next: ChatThemePreference) => void;
  /** Live-set the code-surface preference. Same persistence semantics. */
  setCodeTheme: (next: CodeThemePreference) => void;
}

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
  "high-contrast",
];

export const CHAT_THEME_PREFERENCES: readonly ChatThemePreference[] = [
  "default",
  "lg",
  "purple",
  "orange",
  "blue",
];

export const CODE_THEME_PREFERENCES: readonly CodeThemePreference[] = [
  "auto",
  "light",
  "dark",
];
