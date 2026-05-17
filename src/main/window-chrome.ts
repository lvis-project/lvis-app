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
 *           the OS-drawn traffic lights, positioned 14 px from the left and
 *           vertically centered inside the 36 px CustomTitleBar:
 *             y = (36 - 12) / 2 = 12
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
    trafficLightPosition: isDarwin ? { x: 14, y: 12 } : undefined,
  };
}
