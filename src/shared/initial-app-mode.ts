/**
 * Wire format for the host's "race window = 0" appMode prime — shared between:
 *  - `src/main.ts` (`initialAppModeArgs()` — serializes the persisted appMode)
 *  - `src/preload.ts` (`readInitialAppModeArg()` — deserializes from `process.argv`)
 *  - `src/ui/renderer/App.tsx` (seeds `useState` from `window.__lvisInitialAppMode`)
 *
 * Mirrors the theme-prime contract in `src/shared/initial-theme.ts`: the main
 * process passes the persisted workspace mode into every new main BrowserWindow
 * via `webPreferences.additionalArguments` so the renderer's FIRST React render
 * already paints the correct mode layout (expanded rail for action, collapsed
 * rail for chat) — no flash of the wrong mode followed by a post-mount tween.
 *
 * Keeping the prefix + value set in one module ensures main, preload, and the
 * renderer cannot drift apart silently.
 */

export const INITIAL_APP_MODE_ARG_PREFIX = "--lvis-initial-app-mode=";

/**
 * Workspace mode. SoT for the *value set* lives here so main, preload, and the
 * renderer all validate against the same union. The renderer's `AppMode`
 * (`MainToolbar.tsx`) is the structurally identical UI-facing alias.
 */
export type InitialAppMode = "chat" | "action";

export const APP_MODES: readonly InitialAppMode[] = ["chat", "action"];

/**
 * Default workspace mode on first run (no persisted value yet). `"action"`
 * preserves the historical inline behavior. This is a legitimate first-run
 * default, not a bug-papering fallback.
 */
export const DEFAULT_APP_MODE: InitialAppMode = "action";

export function isAppMode(value: unknown): value is InitialAppMode {
  return value === "chat" || value === "action";
}
