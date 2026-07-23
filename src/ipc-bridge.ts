/**
 * IPC Bridge — §4.1 Main ↔ Renderer ↔ Native
 *
 * This file is now a backwards-compatibility re-export shim.
 * All handler logic has been split into per-domain modules under src/ipc/.
 *
 * External callers (main.ts, window-manager.ts, tests) continue to import
 * from this path without any changes.
 */

export {
  validateSender,
  UNAUTHORIZED_FRAME,
  auditUnauthorized,
  validatePluginFrame,
} from "./ipc/gated.js";

export {
  registerIpcHandlers,
  registerWindowEventListeners,
  unregisterPluginWebview,
} from "./ipc/index.js";

// Preserve the public compatibility facade while keeping main-process callers
// on the extracted leaf cache instead of the IPC domain implementation.
export { getLastThemePayload } from "./shared/plugin-theme-cache.js";
