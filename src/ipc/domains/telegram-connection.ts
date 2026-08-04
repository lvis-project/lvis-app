/**
 * Host-renderer-only IPC for the owner-driven Telegram private-DM connection.
 *
 * Every mutation is an egress decision: saving a bot token, starting the
 * outbound connection, minting a pairing code, and sharing the open
 * conversation each require a live local keyboard intent. The renderer never
 * nominates a conversation, a Telegram id, or a pairing binding — main resolves
 * the active conversation itself when the mutation runs.
 *
 * Handlers register unconditionally so the channel inventory is stable; a build
 * without the owner service answers `telegram-connection-disabled` from inside
 * the handler rather than leaving the channel missing.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import {
  isTelegramApproveCurrentConversationInput,
  isTelegramConnectInput,
  isTelegramIntentOnlyInput,
  isTelegramRevokeInput,
  parseTelegramConnectionMutationResult,
  parseTelegramConnectionSnapshotResult,
  parseTelegramCreatePairingCodeResult,
} from "../../shared/telegram-connection.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";

const DISABLED = Object.freeze({
  ok: false as const,
  error: "telegram-connection-disabled" as const,
});
const INPUT_INVALID = Object.freeze({
  ok: false as const,
  error: "telegram-connection-input-invalid" as const,
});
const KEYBOARD_REQUIRED = Object.freeze({ ok: false as const, error: "user-keyboard-required" as const });
const OPERATION_REJECTED = Object.freeze({
  ok: false as const,
  error: "telegram-connection-operation-rejected" as const,
});
const UNAVAILABLE = Object.freeze({
  ok: false as const,
  error: "telegram-connection-unavailable" as const,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIntent(payload: unknown): boolean {
  return record(payload) && hasUserKeyboardIntent(payload.intent);
}

/**
 * Broadcast only a change hint. Each renderer must refetch its safe snapshot;
 * no pairing code, bot handle, or conversation value travels in this event.
 */
function broadcastTelegramConnectionChanged(deps: IpcDeps): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const window of windows) {
    sendToWindow(window, CHANNELS.telegramConnection.changed, {});
  }
}

export function registerTelegramConnectionHandlers(deps: IpcDeps): void {
  const service = deps.telegramConnectionService;
  if (service) {
    service.subscribe(() => {
      broadcastTelegramConnectionChanged(deps);
    });
  }

  ipcMain.handle(CHANNELS.telegramConnection.snapshot, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.snapshot, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    try {
      return parseTelegramConnectionSnapshotResult(service.snapshot()) ?? UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  });

  ipcMain.handle(CHANNELS.telegramConnection.connect, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.connect, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTelegramConnectInput(payload)) return INPUT_INVALID;
    try {
      return parseTelegramConnectionMutationResult(await service.connect(payload.botToken))
        ?? OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.telegramConnection.disconnect, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.disconnect, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTelegramIntentOnlyInput(payload)) return INPUT_INVALID;
    try {
      return parseTelegramConnectionMutationResult(await service.disconnect()) ?? OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.telegramConnection.pause, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.pause, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTelegramIntentOnlyInput(payload)) return INPUT_INVALID;
    try {
      return parseTelegramConnectionMutationResult(await service.pause()) ?? OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.telegramConnection.resume, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.resume, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTelegramIntentOnlyInput(payload)) return INPUT_INVALID;
    try {
      return parseTelegramConnectionMutationResult(await service.resume()) ?? OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.telegramConnection.createPairingCode, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.createPairingCode, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTelegramIntentOnlyInput(payload)) return INPUT_INVALID;
    try {
      return parseTelegramCreatePairingCodeResult(await service.createPairingCode())
        ?? OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.telegramConnection.revokePairing, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.revokePairing, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTelegramRevokeInput(payload)) return INPUT_INVALID;
    try {
      return parseTelegramConnectionMutationResult(await service.revokePairing(payload.id))
        ?? OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(
    CHANNELS.telegramConnection.approveCurrentConversation,
    async (event, payload: unknown) => {
      if (!validateHostRendererSender(event)) {
        auditUnauthorized(
          deps.auditLogger,
          CHANNELS.telegramConnection.approveCurrentConversation,
          event,
        );
        return UNAUTHORIZED_FRAME;
      }
      if (!service) return DISABLED;
      if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
      if (!isTelegramApproveCurrentConversationInput(payload)) return INPUT_INVALID;
      try {
        return parseTelegramConnectionMutationResult(
          await service.approveCurrentConversation(payload.duration),
        ) ?? OPERATION_REJECTED;
      } catch {
        return OPERATION_REJECTED;
      }
    },
  );

  ipcMain.handle(CHANNELS.telegramConnection.revokeApproval, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.telegramConnection.revokeApproval, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!service) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTelegramRevokeInput(payload)) return INPUT_INVALID;
    try {
      return parseTelegramConnectionMutationResult(await service.revokeApproval(payload.id))
        ?? OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });
}
