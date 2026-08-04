/**
 * IPC shared types — dependency injection bag passed to every domain registrar.
 */
import type { BrowserWindow } from "electron";
import type { AppServices } from "../boot/types.js";
import type { PermissionDirectoryLifecycle } from "../permissions/permission-slash.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../main/conversation-command-port.js";
import type { TailnetSharingOwnerService } from "../main/tailnet-sharing-owner-service.js";
import type { TelegramConnectionService } from "../main/telegram-connection-service.js";

export type IpcDeps = AppServices & {
  getMainWindow: () => BrowserWindow | null;
  getAppWindows?: () => Array<BrowserWindow | null | undefined>;
  /**
   * Main-process-owned workspace registry lifecycle. Workspace handlers wire
   * this once during IPC registration; permission IPC resolves it lazily when
   * a mutating command runs so Settings cannot fall back to settings-only
   * allow/deny writes.
   */
  workspaceRootLifecycle?: PermissionDirectoryLifecycle;
  /**
   * Host-owned event/lease runtime shared by every main-conversation surface.
   * It is injected by main-process composition and intentionally optional for
   * focused domain tests that exercise only one local transport.
   */
  conversationSurfaceRuntime?: ConversationSurfaceRuntime;
  /**
   * One host-composed command entrypoint shared by all main-conversation
   * surfaces. Optional only for focused domain tests.
   */
  conversationCommandPort?: ConversationCommandPort;
  /**
   * Main-only owner facade for explicit Tailnet pairing and per-conversation
   * sharing. It is absent unless the immutable P2 boot gate is enabled.
   */
  tailnetSharingOwnerService?: TailnetSharingOwnerService;
  /**
   * Main-only owner facade for the Telegram private-DM connection. Absent
   * unless main composition built it, in which case every channel answers
   * `telegram-connection-disabled`.
   */
  telegramConnectionService?: TelegramConnectionService;
};
