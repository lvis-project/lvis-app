/**
 * IPC registration orchestrator.
 *
 * Replaces the monolithic `src/ipc-bridge.ts::registerIpcHandlers` with
 * per-domain registrars. Each domain file owns its own slice of channels;
 * `ipc-bridge.ts` delegates here and re-exports the public API so external
 * callers don't need to update their imports.
 *
 * Domain → channel prefix mapping:
 *   settings     lvis:settings:*, lvis:shell:*, lvis:telemetry:consent-answer
 *   auth         lvis:auth:* (#893 mockup login)
 *   demo         lvis:demo:* (activation-code → .env.demo decrypt + persist)
 *   tour         lvis:tour:*        — Tutorial-C SpotlightTour state + broadcast
 *   tutorial     lvis:tutorial:*    — Tutorial-D Discovery Swipe state + open trigger
 *   chat         lvis:chat:*, lvis:llm:*, lvis:routines:*, lvis:routine:*, lvis:trigger:*,
 *                lvis:memory:*, lvis:starred:*, lvis:feedback:*, lvis:ask-user-question:*
 *   plugins      lvis:plugins:*, lvis:bootstrap:*, lvis:runtime:*, lvis:marketplace:*,
 *                lvis:mcp:*, lvis:plugin:*, lvis:file:*, lvis:notification:clicked
 *   usage        lvis:usage:*
 *   audit        lvis:audit:*, lvis:dlp:*
 *   permissions  lvis:permission:*, lvis:approval:*, lvis:policy:*
 *   window       window:*
 *   misc         lvis:routines:v2:*, lvis:session-todo:*
 *   ui           lvis:ui:*
 *   dev          lvis:dev:*  (only registered when !app.isPackaged)
 */
import { initDlpAudit } from "../audit/dlp-filter.js";
import { getIsPackaged } from "../boot/dev-flags.js";
import { registerSettingsHandlers } from "./domains/settings.js";
import { registerAuthHandlers } from "./domains/auth.js";
import { registerDemoHandlers } from "./domains/demo.js";
import { registerTourHandlers } from "./domains/tour.js";
import { registerTutorialHandlers } from "./domains/tutorial.js";
import { registerChatHandlers } from "./domains/chat.js";
import { registerPluginsHandlers } from "./domains/plugins.js";
import { registerUsageHandlers } from "./domains/usage.js";
import { registerAuditHandlers } from "./domains/audit.js";
import { registerPermissionsHandlers } from "./domains/permissions.js";
import { registerWindowHandlers } from "./domains/window.js";
import { registerMiscHandlers } from "./domains/misc.js";
import { registerAttachHandlers } from "./domains/attach.js";
import { registerUiHandlers } from "./domains/ui.js";
import { registerDevHandlers } from "./domains/dev.js";
import type { IpcDeps } from "./types.js";
import type { AppServices } from "../boot/types.js";
import type { BrowserWindow } from "electron";

export type { IpcDeps } from "./types.js";
export { registerWindowEventListeners } from "./domains/window.js";
export { unregisterPluginWebview } from "./domains/plugins.js";
export { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "./gated.js";

/**
 * Register all IPC handlers. Called once during app boot (from main.ts /
 * ipc-bridge.ts). The `services` bag is spread into `IpcDeps` along with
 * the `getMainWindow` accessor.
 */
export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
  getAppWindows: () => Array<BrowserWindow | null | undefined> = () => [getMainWindow()],
): void {
  const deps: IpcDeps = { ...services, getMainWindow, getAppWindows };

  // Wire DLP audit logging so redactForLLM records hits to audit JSONL.
  initDlpAudit(deps.auditLogger, deps.conversationLoop.getSessionId());

  registerSettingsHandlers(deps);
  registerAuthHandlers(deps);
  registerDemoHandlers(deps);
  registerTourHandlers(deps);
  registerTutorialHandlers(deps);
  registerChatHandlers(deps);
  registerPluginsHandlers(deps);
  registerUsageHandlers(deps);
  registerAuditHandlers(deps);
  registerPermissionsHandlers(deps);
  registerWindowHandlers(deps);
  registerMiscHandlers(deps);
  registerAttachHandlers(deps);
  registerUiHandlers(deps);
  // Dev IPC is *not* registered in packaged builds — the channels never
  // exist on `ipcMain`, so a compromised renderer/preload cannot probe them.
  if (!getIsPackaged()) {
    registerDevHandlers(deps);
  }
}
