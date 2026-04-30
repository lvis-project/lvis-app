/**
 * UX Track 3 — theme system public types.
 *
 * Mirrors `AppearanceSettings.theme` from `src/data/settings-store.ts` so the
 * renderer can ship without importing main-process types directly. Keep this
 * union in sync with `ThemePreference` there.
 *
 * `ResolvedTheme` is what gets written to <html data-theme="…">: "system"
 * is resolved against `prefers-color-scheme` before being applied.
 */
export type ThemePreference = "system" | "light" | "dark" | "high-contrast";

export type ResolvedTheme = "light" | "dark" | "high-contrast";

export interface ThemeContextValue {
  /** User-facing preference (what the picker shows). */
  preference: ThemePreference;
  /** Concrete theme actually applied to <html data-theme>. */
  resolved: ResolvedTheme;
  /**
   * Live-set the preference. Updates the DOM immediately and persists to
   * `~/.lvis/settings.json` via `api.updateSettings({ appearance: ... })` if
   * the provider was given an api.
   */
  setPreference: (next: ThemePreference) => void;
}

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "light",
  "dark",
  "high-contrast",
];
