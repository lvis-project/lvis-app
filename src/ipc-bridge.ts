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
