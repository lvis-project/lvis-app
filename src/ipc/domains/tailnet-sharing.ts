/**
 * Host-renderer-only IPC for local Tailnet pairing and scoped sharing.
 *
 * This is intentionally not a remote API: every mutation needs a live local
 * keyboard intent, and the handler gets the active conversation only through
 * the main-owned owner service. The renderer cannot nominate a session,
 * Tailnet login, raw actor id, or pairing binding.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import {
  isTailnetSharingActivatePairingInput,
  isTailnetSharingCreateCurrentConversationShareInput,
  isTailnetSharingCreateInvitationInput,
  isTailnetSharingRevokeInput,
  parseTailnetSharingCreatedInvitation,
  parseTailnetSharingSnapshot,
} from "../../shared/tailnet-sharing.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import { sendToWindow } from "../safe-send.js";
import type { IpcDeps } from "../types.js";

const DISABLED = Object.freeze({ ok: false as const, error: "tailnet-sharing-disabled" as const });
const INPUT_INVALID = Object.freeze({ ok: false as const, error: "tailnet-sharing-input-invalid" as const });
const KEYBOARD_REQUIRED = Object.freeze({ ok: false as const, error: "user-keyboard-required" as const });
const OPERATION_REJECTED = Object.freeze({
  ok: false as const,
  error: "tailnet-sharing-operation-rejected" as const,
});
const UNAVAILABLE = Object.freeze({ ok: false as const, error: "tailnet-sharing-unavailable" as const });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIntent(payload: unknown): boolean {
  return record(payload) && hasUserKeyboardIntent(payload.intent);
}

/**
 * Broadcast only a change hint. Each renderer must refetch its safe snapshot;
 * neither invitation codes nor pairing/share data travel in this event.
 */
function broadcastTailnetSharingChanged(deps: IpcDeps): void {
  const mainWindow = deps.getMainWindow?.();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const window of windows) {
    sendToWindow(window, CHANNELS.tailnetSharing.changed, {});
  }
}

export function registerTailnetSharingHandlers(deps: IpcDeps): void {
  const owner = deps.tailnetSharingOwnerService;
  if (owner) {
    owner.subscribe(() => {
      broadcastTailnetSharingChanged(deps);
    });
  }

  ipcMain.handle(CHANNELS.tailnetSharing.snapshot, (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.snapshot, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    try {
      const snapshot = parseTailnetSharingSnapshot(owner.snapshot());
      return snapshot === null
        ? UNAVAILABLE : { ok: true as const, snapshot };
    } catch {
      return UNAVAILABLE;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.createInvitation, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.createInvitation, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTailnetSharingCreateInvitationInput(payload)) return INPUT_INVALID;
    try {
      const invitation = parseTailnetSharingCreatedInvitation(
        await owner.createInvitation(payload.duration),
      );
      return invitation === null
        ? OPERATION_REJECTED : { ok: true as const, invitation };
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.activatePairing, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.activatePairing, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTailnetSharingActivatePairingInput(payload)) return INPUT_INVALID;
    try {
      return await owner.activatePairing(payload.id)
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.createCurrentConversationShare, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.createCurrentConversationShare, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTailnetSharingCreateCurrentConversationShareInput(payload)) return INPUT_INVALID;
    try {
      return await owner.createCurrentConversationShare(
        payload.pairingId,
        payload.permission,
        payload.duration,
      )
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.revokeShare, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.revokeShare, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTailnetSharingRevokeInput(payload)) return INPUT_INVALID;
    try {
      return await owner.revokeShare(payload.id)
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });

  ipcMain.handle(CHANNELS.tailnetSharing.revokePairing, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.tailnetSharing.revokePairing, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!owner) return DISABLED;
    if (!hasIntent(payload)) return KEYBOARD_REQUIRED;
    if (!isTailnetSharingRevokeInput(payload)) return INPUT_INVALID;
    try {
      return await owner.revokePairing(payload.id)
        ? { ok: true as const }
        : OPERATION_REJECTED;
    } catch {
      return OPERATION_REJECTED;
    }
  });
}
