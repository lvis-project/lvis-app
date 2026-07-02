import { DEFAULT_APP_MODE, normalizeAppMode } from "../../../shared/initial-app-mode.js";
import type { AppMode } from "../MainToolbar.js";

/**
 * Read the persisted workspace mode that the main process injected before the
 * renderer loaded (preload exposes it as `window.__lvisInitialAppMode`, mirror
 * of the `__lvisInitialTheme` prime). Reading it here — at `useState`
 * initializer time, before first paint — means the shell renders the correct
 * mode layout on frame 0 instead of mounting in "work" and tweening to the
 * restored mode in a post-mount effect (the wrong-mode flash).
 *
 * `DEFAULT_APP_MODE` ("work") covers the non-Electron test harness and the
 * cold-boot-before-settings window — both legitimate first-run defaults.
 */
export function readInitialAppMode(): AppMode {
  if (typeof window === "undefined") return DEFAULT_APP_MODE;
  const raw = (window as { __lvisInitialAppMode?: unknown }).__lvisInitialAppMode;
  return normalizeAppMode(raw) ?? DEFAULT_APP_MODE;
}
