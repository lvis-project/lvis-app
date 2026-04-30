import type { ResolvedTheme, ThemePreference } from "./types.js";

/**
 * UX Track 3 — resolve a user preference to the concrete theme that should
 * be applied to <html data-theme="…">.
 *
 * "system" reads `prefers-color-scheme`; if matchMedia is unavailable
 * (older Electron / SSR / test envs without the polyfill) it falls back
 * to "dark" — the historical app default.
 *
 * High-contrast is never inferred from the OS — it's an explicit opt-in.
 */
export function resolveTheme(
  preference: ThemePreference,
  win: Pick<Window, "matchMedia"> | undefined = typeof window !== "undefined" ? window : undefined,
): ResolvedTheme {
  if (preference === "light" || preference === "dark" || preference === "high-contrast") {
    return preference;
  }
  // preference === "system"
  try {
    const mql = win?.matchMedia?.("(prefers-color-scheme: light)");
    if (mql && mql.matches) return "light";
  } catch {
    /* matchMedia unsupported — fall through */
  }
  return "dark";
}

/**
 * Apply the resolved theme to a target document element. Idempotent.
 *
 * Writing `data-theme` on <html> is what activates the matching semantic
 * token block in `styles.css`. We also write a `lvis-theme-*` class so
 * test snapshots / CSS selectors can match without relying on attribute
 * selectors.
 */
export function applyThemeToDocument(theme: ResolvedTheme, doc: Document = document): void {
  const root = doc.documentElement;
  root.setAttribute("data-theme", theme);
  root.classList.remove("lvis-theme-light", "lvis-theme-dark", "lvis-theme-high-contrast");
  root.classList.add(`lvis-theme-${theme}`);
}
