/**
 * Common chrome options shared by every LVIS BrowserWindow (main, settings,
 * link-window, auth-window).
 *
 * The cross-window visual identity depends on the 36 px CustomTitleBar +
 * native traffic lights landing in the exact same spot across all surfaces.
 * Drifting any of these three values per-window will silently break the
 * "all windows look like one app" property — extract here so a single
 * source-of-truth governs the platform branching.
 *
 *  - macOS: keep native frame; `hiddenInset` removes the title bar but keeps
 *           the OS-drawn traffic lights, positioned 18 px from the left with a
 *           modest top inset (y:16) so they breathe inside the band. The band /
 *           titlebar left clearance grows in lockstep (CustomTitleBar pl) so the
 *           leftmost cluster button never hover-overlaps the OS lights.
 *  - Win/Linux: remove native frame entirely; `CustomTitleBar.tsx` renders
 *               our own minimize / maximize / close buttons in the renderer.
 *
 * Usage:
 *   new BrowserWindow({ ...getCommonChromeOptions(), width, height, ... })
 *
 * NEVER inline `frame` / `titleBarStyle` / `trafficLightPosition` directly
 * in a `new BrowserWindow(...)` call — always spread this helper. The
 * helper has been validated against `mainWindow` (main.ts), `settingsWindow`
 * (main.ts), `link-window-service.ts`, and `auth-window-service.ts`.
 */
import type { BrowserWindowConstructorOptions } from "electron";

export function getCommonChromeOptions(): Partial<BrowserWindowConstructorOptions> {
  const isDarwin = process.platform === "darwin";
  return {
    frame: isDarwin,
    titleBarStyle: isDarwin ? "hiddenInset" : "hidden",
    trafficLightPosition: isDarwin ? { x: 18, y: 16 } : undefined,
  };
}
