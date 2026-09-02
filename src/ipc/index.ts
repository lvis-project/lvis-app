/**
 * IPC registration orchestrator.
 *
 * Handler registration is split per domain: each domain file owns its own
 * slice of channels, and `ipc-bridge.ts` delegates here while re-exporting the
 * public API, so an external caller imports from either without knowing which.
 *
 * Domain → channel prefix mapping. One line per registrar called below, so a
 * reader can answer "which file owns this channel" without opening all of them:
 *   settings      lvis:settings:*, lvis:shell:open-external,
 *                 lvis:telemetry:consent-answer
 *   tour          lvis:tour:*        — SpotlightTour state + broadcast
 *   chat          lvis:chat:*, lvis:llm:*, lvis:memory:*, lvis:starred:*,
 *                 lvis:feedback:*, lvis:ask-user-question:*
 *   sidechat      lvis:sidechat:*
 *   plugins       lvis:plugins:*, lvis:plugin:*, lvis:mcp:*, lvis:runtime:*,
 *                 lvis:agents:*, lvis:skills:*, lvis:bootstrap:retry,
 *                 lvis:marketplace:ping, lvis:host:plugin-theme-notify,
 *                 lvis:notification:clicked
 *   prompts       lvis:prompts:*
 *   usage         lvis:usage:*
 *   audit         lvis:audit:*, lvis:dlp:*
 *   diagnostics   lvis:diagnostics:*, lvis:logs:tail
 *   permissions   lvis:permission:*, lvis:permissions:*, lvis:approval:respond,
 *                 lvis:policy:*
 *   window        window:*, lvis:window:open-html-preview
 *   routines      lvis:routines:*
 *   session-tasks  lvis:session-tasks:*
 *   app           lvis:app:*
 *   work-board    lvis:work-board:* (CRUD, lifecycle, run, run-transcript,
 *                 generate-report)
 *   attach        lvis:attach:*
 *   preview       lvis:preview:read-file
 *   workspace     lvis:workspace:*
 *   ui            lvis:ui:*
 *   terminal      lvis:terminal:*
 *   remote-a2a    lvis:a2a-remote:*
 *   tailnet-sharing     lvis:tailnet-sharing:*
 *   telegram-connection lvis:telegram-connection:*
 *   away-authority      lvis:away-authority:*
 *   dev           lvis:dev:*  (registered only when `getIsPackaged()` is false)
 *
 * `lvis:trigger:*` is absent on purpose. The constants exist in
 * `contract/app-contract.ts` and the preload invokes `trigger.dismiss` and
 * `trigger.import`, but no `ipcMain.handle` for any `lvis:trigger:` channel
 * exists in `src/` — those two invokes have no receiver. Recorded rather than
 * fixed here: giving them one is a behaviour change, not a rename.
 */
import { initDlpAudit } from "../audit/dlp-filter.js";
import { getIsPackaged } from "../boot/dev-flags.js";
import { registerSettingsHandlers } from "./domains/settings.js";
import { registerTourHandlers } from "./domains/tour.js";
import { registerChatHandlers } from "./domains/chat.js";
import { registerSideChatHandlers } from "./domains/sidechat.js";
import { registerPluginsHandlers } from "./domains/plugins.js";
import { registerPromptHandlers } from "./domains/prompts.js";
import { registerUsageHandlers } from "./domains/usage.js";
import { registerAuditHandlers } from "./domains/audit.js";
import { registerDiagnosticsHandlers } from "./domains/diagnostics.js";
import { registerPermissionsHandlers } from "./domains/permissions.js";
import { registerWindowHandlers } from "./domains/window.js";
import { registerRoutineHandlers } from "./domains/routines.js";
import { registerSessionTasksHandlers } from "./domains/session-tasks.js";
import { registerSessionGoalHandlers } from "./domains/session-goal.js";
import { registerAppHandlers } from "./domains/app.js";
import { registerWorkBoardHandlers } from "./domains/work-board.js";
import { registerAttachHandlers } from "./domains/attach.js";
import { registerPreviewHandlers } from "./domains/preview.js";
import { registerWorkspaceHandlers } from "./domains/workspace.js";
import { registerUiHandlers } from "./domains/ui.js";
import { registerTerminalHandlers } from "./domains/terminal.js";
import { registerDevHandlers } from "./domains/dev.js";
import { registerRemoteA2AHandlers } from "./domains/remote-a2a.js";
import { registerTailnetObserverHandlers } from "./domains/tailnet-observer.js";
import { registerTailnetSharingHandlers } from "./domains/tailnet-sharing.js";
import { registerTelegramConnectionHandlers } from "./domains/telegram-connection.js";
import { registerAwayAuthorityHandlers } from "./domains/away-authority.js";
import type { IpcDeps } from "./types.js";
import type { AppServices } from "../boot/types.js";
import type { BrowserWindow } from "electron";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../main/conversation-command-port.js";
import type { TailnetSharingOwnerService } from "../main/tailnet-sharing-owner-service.js";
import type { TelegramConnectionService } from "../main/telegram-connection-service.js";
import type { TailnetObserverConfigService } from "../main/tailnet-observer-config-service.js";

export type { IpcDeps } from "./types.js";
export { registerWindowEventListeners } from "./domains/window.js";
export { unregisterPluginWebview } from "./domains/plugins.js";
export { validateSender, validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "./gated.js";

/**
 * Register all IPC handlers. Called once during app boot (from main.ts /
 * ipc-bridge.ts). The `services` bag is spread into `IpcDeps` along with
 * the `getMainWindow` accessor.
 */
export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
  getAppWindows: () => Array<BrowserWindow | null | undefined> = () => [getMainWindow()],
  conversationSurfaceRuntime?: ConversationSurfaceRuntime,
  conversationCommandPort?: ConversationCommandPort,
  tailnetSharingOwnerService?: TailnetSharingOwnerService,
  telegramConnectionService?: TelegramConnectionService,
  tailnetObserverConfigService?: TailnetObserverConfigService,
): void {
  const deps: IpcDeps = {
    ...services,
    getMainWindow,
    getAppWindows,
    ...(conversationSurfaceRuntime ? { conversationSurfaceRuntime } : {}),
    ...(conversationCommandPort ? { conversationCommandPort } : {}),
    ...(tailnetSharingOwnerService ? { tailnetSharingOwnerService } : {}),
    ...(telegramConnectionService ? { telegramConnectionService } : {}),
    ...(tailnetObserverConfigService ? { tailnetObserverConfigService } : {}),
  };

  // Resolve the session at each DLP hit: chat new/resume/fork can change the
  // loop's session after handlers have been registered.
  initDlpAudit(deps.auditLogger, () => deps.conversationLoop.getSessionId());

  registerSettingsHandlers(deps);
  registerTourHandlers(deps);
  registerChatHandlers(deps);
  registerSideChatHandlers(deps);
  registerPluginsHandlers(deps);
  registerPromptHandlers(deps);
  registerUsageHandlers(deps);
  registerAuditHandlers(deps);
  registerDiagnosticsHandlers(deps);
  registerPermissionsHandlers(deps);
  registerWindowHandlers(deps);
  registerRoutineHandlers(deps);
  registerSessionTasksHandlers(deps);
  registerSessionGoalHandlers(deps);
  registerAppHandlers(deps);
  registerWorkBoardHandlers(deps);
  registerAttachHandlers(deps);
  registerPreviewHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerUiHandlers(deps);
  registerTerminalHandlers(deps);
  registerRemoteA2AHandlers(deps);
  registerTailnetSharingHandlers(deps);
  registerTailnetObserverHandlers(deps);
  registerTelegramConnectionHandlers(deps);
  registerAwayAuthorityHandlers(deps);
  // Dev IPC is *not* registered in packaged builds — the channels never
  // exist on `ipcMain`, so a compromised renderer/preload cannot probe them.
  if (!getIsPackaged()) {
    registerDevHandlers(deps);
  }
}
