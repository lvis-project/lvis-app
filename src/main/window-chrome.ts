/**
 * Common chrome options shared by every LVIS BrowserWindow (main,
 * link-window, auth-window).
 *
 * The cross-window visual identity depends on the 36 px CustomTitleBar +
 * native traffic lights landing in the exact same spot across all surfaces.
 * Drifting any of these three values per-window will silently break the
 * "all windows look like one app" property — extract here so a single
 * source-of-truth governs the platform branching.
 *
 *  - macOS: keep native frame; `hiddenInset` removes the title bar but keeps
 *           the OS-drawn traffic lights at `TRAFFIC_LIGHT_POSITION` so they
 *           breathe inside the band. The band / titlebar left clearance is
 *           derived from that same position (CustomTitleBar pl) so the
 *           leftmost cluster button never hover-overlaps the OS lights.
 *  - Win/Linux: remove native frame entirely; `CustomTitleBar.tsx` renders
 *               our own minimize / maximize / close buttons in the renderer.
 *
 * Usage:
 *   new BrowserWindow({ ...getCommonChromeOptions(), width, height, ... })
 *
 * NEVER inline `frame` / `titleBarStyle` / `trafficLightPosition` directly
 * in a `new BrowserWindow(...)` call — always spread this helper. The
 * helper has been validated against `main-window.ts`,
 * `link-window-service.ts`, and `auth-window-service.ts`.
 */
import type { BrowserWindowConstructorOptions } from "electron";
import { TRAFFIC_LIGHT_POSITION } from "../shared/shell-geometry.js";

export function getCommonChromeOptions(): Partial<BrowserWindowConstructorOptions> {
  const isDarwin = process.platform === "darwin";
  return {
    frame: isDarwin,
    titleBarStyle: isDarwin ? "hiddenInset" : "hidden",
    // The position, and the reason it pairs with the band height, live in
    // `shared/shell-geometry.ts` — the renderer derives its own clearances
    // from the same constant, so the two sides cannot drift apart.
    trafficLightPosition: isDarwin ? { ...TRAFFIC_LIGHT_POSITION } : undefined,
  };
}
