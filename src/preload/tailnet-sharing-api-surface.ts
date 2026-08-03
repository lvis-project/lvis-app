/**
 * Narrow host-renderer bridge for local-owner Tailnet sharing controls.
 *
 * This is intentionally a leaf: plugin frames and public/external surfaces do
 * not receive it. Mutating calls mint their own live keyboard intent in preload
 * so a renderer cannot replay or fabricate a permission decision.
 */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseTailnetSharingCreateInvitationResult,
  parseTailnetSharingMutationResult,
  parseTailnetSharingSnapshotResult,
  type TailnetInvitationDurationPreset,
  type TailnetShareDurationPreset,
  type TailnetSharePermission,
  type TailnetSharingCreateInvitationResult,
  type TailnetSharingMutationResult,
  type TailnetSharingOwnerApi,
  type TailnetSharingSnapshotResult,
} from "../shared/tailnet-sharing.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

function unavailableMutation(): TailnetSharingMutationResult {
  return Object.freeze({ ok: false, error: "tailnet-sharing-unavailable" });
}

function unavailableSnapshot(): TailnetSharingSnapshotResult {
  return Object.freeze({ ok: false, error: "tailnet-sharing-unavailable" });
}

function unavailableInvitation(): TailnetSharingCreateInvitationResult {
  return Object.freeze({ ok: false, error: "tailnet-sharing-unavailable" });
}

async function invokeMutation(channel: string, payload: unknown): Promise<TailnetSharingMutationResult> {
  try {
    return parseTailnetSharingMutationResult(await ipcRenderer.invoke(channel, payload))
      ?? unavailableMutation();
  } catch {
    return unavailableMutation();
  }
}

/** Build the private `window.lvisApi.tailnetSharing` namespace. */
export function buildTailnetSharingApiSurface(): TailnetSharingOwnerApi {
  return Object.freeze({
    async snapshot(): Promise<TailnetSharingSnapshotResult> {
      try {
        return parseTailnetSharingSnapshotResult(await ipcRenderer.invoke(CHANNELS.tailnetSharing.snapshot))
          ?? unavailableSnapshot();
      } catch {
        return unavailableSnapshot();
      }
    },

    async createInvitation(
      duration?: TailnetInvitationDurationPreset,
    ): Promise<TailnetSharingCreateInvitationResult> {
      const payload = duration === undefined
        ? { intent: ipcUserKeyboardIntent() }
        : { duration, intent: ipcUserKeyboardIntent() };
      try {
        return parseTailnetSharingCreateInvitationResult(
          await ipcRenderer.invoke(CHANNELS.tailnetSharing.createInvitation, payload),
        ) ?? unavailableInvitation();
      } catch {
        return unavailableInvitation();
      }
    },

    activatePairing(id: string): Promise<TailnetSharingMutationResult> {
      return invokeMutation(CHANNELS.tailnetSharing.activatePairing, {
        id,
        intent: ipcUserKeyboardIntent(),
      });
    },

    createCurrentConversationShare(
      pairingId: string,
      permission: TailnetSharePermission,
      duration?: TailnetShareDurationPreset,
    ): Promise<TailnetSharingMutationResult> {
      const payload = duration === undefined
        ? { pairingId, permission, intent: ipcUserKeyboardIntent() }
        : { pairingId, permission, duration, intent: ipcUserKeyboardIntent() };
      return invokeMutation(CHANNELS.tailnetSharing.createCurrentConversationShare, payload);
    },

    revokeShare(id: string): Promise<TailnetSharingMutationResult> {
      return invokeMutation(CHANNELS.tailnetSharing.revokeShare, {
        id,
        intent: ipcUserKeyboardIntent(),
      });
    },

    revokePairing(id: string): Promise<TailnetSharingMutationResult> {
      return invokeMutation(CHANNELS.tailnetSharing.revokePairing, {
        id,
        intent: ipcUserKeyboardIntent(),
      });
    },

    onChanged(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on(CHANNELS.tailnetSharing.changed, listener);
      return () => ipcRenderer.removeListener(CHANNELS.tailnetSharing.changed, listener);
    },
  });
}
