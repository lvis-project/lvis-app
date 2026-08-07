/**
 * The ONE host-side (non-IPC-deps) permission-config broadcast.
 *
 * `PERMISSIONS.configChanged` tells every host renderer window that the
 * permission/directory config mutated so multi-window PermissionsTab views
 * refresh. IPC handlers already fan it out through
 * `ipc/domains/permissions.ts:broadcastPermissionConfigChanged` using the
 * curated window set that `main.ts` injects into `IpcDeps`.
 *
 * Boot-time callers (reviewer wiring, the conversation loops, the plugin-surface
 * executor) have no `IpcDeps`, so each of them used to hand-build a stand-in
 * `{ getMainWindow, getAppWindows: () => BrowserWindow.getAllWindows() }` and
 * force it through with a cast. Four copies, and every one of them passed the
 * RAW window list instead of the curated `getAppWindows` — which reaches
 * top-level windows that are deliberately excluded from host broadcasts (the
 * OAuth window, the external-link window, the auth-partition viewer), since
 * `sendToWindow` checks only `isDestroyed()` and does no origin check.
 *
 * This module is the single boot-side entry point: one derivation of the window
 * set, taken from the same `main/main-window.ts:getAppWindows` authority the
 * IPC path uses.
 */
import { getAppWindows } from "../main/main-window.js";
import { getMainWindow } from "../main/app-state.js";
import { broadcastPermissionConfigChanged } from "../ipc/domains/permissions.js";

export function broadcastPermissionConfigChangedFromHost(): void {
  broadcastPermissionConfigChanged({ getMainWindow, getAppWindows });
}
