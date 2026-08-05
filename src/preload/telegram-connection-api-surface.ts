/**
 * Narrow host-renderer bridge for the local-owner Telegram connection.
 *
 * This is intentionally a leaf: plugin frames and public/external surfaces do
 * not receive it. Mutating calls mint their own live keyboard intent in preload
 * so a renderer cannot replay or fabricate an owner decision.
 *
 * The bot token travels one way only: there is no read-back channel, and no
 * reply shape carries it, the webhook secret, or a Telegram id.
 *
 * One reply does carry a secret, by design. `createPairingCode` returns the raw
 * code once, because the owner has to read it off the screen and send it to the
 * bot themselves. It is short-lived and attempt-limited, and no other reply —
 * the snapshot included — can hand it back afterwards.
 */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseTelegramConnectionMutationResult,
  parseTelegramConnectionSnapshotResult,
  parseTelegramCreatePairingCodeResult,
  type TelegramApprovalDurationPreset,
  type TelegramConnectionMutationResult,
  type TelegramConnectionOwnerApi,
  type TelegramConnectionSnapshotResult,
  type TelegramCreatePairingCodeResult,
} from "../shared/telegram-connection.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";

function unavailableMutation(): TelegramConnectionMutationResult {
  return Object.freeze({ ok: false, error: "telegram-connection-unavailable" });
}

function unavailableSnapshot(): TelegramConnectionSnapshotResult {
  return Object.freeze({ ok: false, error: "telegram-connection-unavailable" });
}

function unavailablePairingCode(): TelegramCreatePairingCodeResult {
  return Object.freeze({ ok: false, error: "telegram-connection-unavailable" });
}

async function invokeMutation(
  channel: string,
  payload: unknown,
): Promise<TelegramConnectionMutationResult> {
  try {
    return parseTelegramConnectionMutationResult(await ipcRenderer.invoke(channel, payload))
      ?? unavailableMutation();
  } catch {
    return unavailableMutation();
  }
}

function intentOnly(channel: string): Promise<TelegramConnectionMutationResult> {
  return invokeMutation(channel, { intent: ipcUserKeyboardIntent() });
}

/** Build the private `window.lvisApi.telegramConnection` namespace. */
export function buildTelegramConnectionApiSurface(): TelegramConnectionOwnerApi {
  return Object.freeze({
    async snapshot(): Promise<TelegramConnectionSnapshotResult> {
      try {
        return parseTelegramConnectionSnapshotResult(
          await ipcRenderer.invoke(CHANNELS.telegramConnection.snapshot),
        ) ?? unavailableSnapshot();
      } catch {
        return unavailableSnapshot();
      }
    },

    connect(botToken: string): Promise<TelegramConnectionMutationResult> {
      return invokeMutation(CHANNELS.telegramConnection.connect, {
        botToken,
        intent: ipcUserKeyboardIntent(),
      });
    },

    disconnect(): Promise<TelegramConnectionMutationResult> {
      return intentOnly(CHANNELS.telegramConnection.disconnect);
    },

    pause(): Promise<TelegramConnectionMutationResult> {
      return intentOnly(CHANNELS.telegramConnection.pause);
    },

    resume(): Promise<TelegramConnectionMutationResult> {
      return intentOnly(CHANNELS.telegramConnection.resume);
    },

    async createPairingCode(): Promise<TelegramCreatePairingCodeResult> {
      try {
        return parseTelegramCreatePairingCodeResult(
          await ipcRenderer.invoke(CHANNELS.telegramConnection.createPairingCode, {
            intent: ipcUserKeyboardIntent(),
          }),
        ) ?? unavailablePairingCode();
      } catch {
        return unavailablePairingCode();
      }
    },

    revokePairing(id: string): Promise<TelegramConnectionMutationResult> {
      return invokeMutation(CHANNELS.telegramConnection.revokePairing, {
        id,
        intent: ipcUserKeyboardIntent(),
      });
    },

    approveCurrentConversation(
      duration?: TelegramApprovalDurationPreset,
    ): Promise<TelegramConnectionMutationResult> {
      const payload = duration === undefined
        ? { intent: ipcUserKeyboardIntent() }
        : { duration, intent: ipcUserKeyboardIntent() };
      return invokeMutation(CHANNELS.telegramConnection.approveCurrentConversation, payload);
    },

    revokeApproval(id: string): Promise<TelegramConnectionMutationResult> {
      return invokeMutation(CHANNELS.telegramConnection.revokeApproval, {
        id,
        intent: ipcUserKeyboardIntent(),
      });
    },

    onChanged(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on(CHANNELS.telegramConnection.changed, listener);
      return () => ipcRenderer.removeListener(CHANNELS.telegramConnection.changed, listener);
    },
  });
}
