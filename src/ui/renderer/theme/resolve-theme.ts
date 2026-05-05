import type {
  ChatThemePreference,
  CodeThemePreference,
  ResolvedCodeTheme,
  ResolvedTheme,
  ThemePreference,
} from "./types.js";

/**
 * UX Track 3 — resolve a user shell preference to the concrete theme that
 * should be applied to <html data-theme="…">.
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
 * Resolve the user code-theme preference to the concrete scheme.
 *
 * "auto" mirrors the resolved shell theme: a light shell pairs with a
 * light code panel; dark and high-contrast shells pair with dark code.
 * Explicit "light" / "dark" wins regardless of shell.
 */
export function resolveCodeTheme(
  preference: CodeThemePreference,
  resolvedShell: ResolvedTheme,
): ResolvedCodeTheme {
  if (preference === "light" || preference === "dark") return preference;
  // preference === "auto" — follow the shell.
  return resolvedShell === "light" ? "light" : "dark";
}

/**
 * Apply the resolved shell theme to a target document element. Idempotent.
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

/**
 * Apply the chat theme preference to a target document element.
 * "default" REMOVES the attribute so the dark/light shell defaults win
 * (no override). Anything else writes a `data-chat-theme` value that is
 * matched by the chat-theme overlay block in styles.css.
 */
export function applyChatThemeToDocument(
  chatTheme: ChatThemePreference,
  doc: Document = document,
): void {
  const root = doc.documentElement;
  if (chatTheme === "default") {
    root.removeAttribute("data-chat-theme");
  } else {
    root.setAttribute("data-chat-theme", chatTheme);
  }
}

/**
 * Apply the resolved code theme to a target document element.
 * Always writes the attribute (no "auto" — already resolved by the
 * caller) so code-surface tokens are deterministic regardless of shell.
 */
export function applyCodeThemeToDocument(
  codeTheme: ResolvedCodeTheme,
  doc: Document = document,
): void {
  const root = doc.documentElement;
  root.setAttribute("data-code-theme", codeTheme);
}
