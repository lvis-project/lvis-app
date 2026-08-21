/**
 * IPC shared types — dependency injection bag passed to every domain registrar.
 */
import type { BrowserWindow } from "electron";
import type { AppServices } from "../boot/types.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "../main/conversation-command-port.js";
import type { TailnetSharingOwnerService } from "../main/tailnet-sharing-owner-service.js";
import type { TelegramConnectionService } from "../main/telegram-connection-service.js";
import type { TailnetObserverConfigService } from "../main/tailnet-observer-config-service.js";

export type IpcDeps = AppServices & {
  getMainWindow: () => BrowserWindow | null;
  getAppWindows?: () => Array<BrowserWindow | null | undefined>;
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
  /**
   * Main-only owner facade for the Tailnet observer configuration. Absent
   * unless main composition built it, in which case every channel answers
   * `tailnet-observer-unavailable`.
   */
  tailnetObserverConfigService?: TailnetObserverConfigService;
};
