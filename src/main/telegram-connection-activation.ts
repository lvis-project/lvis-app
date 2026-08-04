/**
 * Composition glue between the owner's durable connection state and the
 * bridge activation.
 *
 * It exists so `main.ts` does not have to know how a stored pairing becomes an
 * egress authority, and so the credential is read at activation time from the
 * encrypted store rather than being held anywhere longer-lived.
 */
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import { createTelegramBotApiClient } from "./telegram-bot-api-client.js";
import { maybeStartTelegramConnectionBridge } from "./telegram-bridge-server.js";
import { createTelegramControlReplySender } from "./telegram-control-reply.js";
import type { TelegramConnectionStore } from "./telegram-connection-store.js";
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from "./telegram-connection-service.js";
import {
  createTelegramActorDigester,
  telegramConversationDigest,
} from "./telegram-platform-runtime.js";

export interface StartTelegramConnectionActivationOptions {
  readonly store: TelegramConnectionStore;
  readonly settingsService: { getEncryptedSecret(key: string): string | null };
  readonly conversationSurfaceRuntime: ConversationSurfaceRuntime;
  readonly conversationCommandPort: ConversationCommandPort;
  readonly getCurrentConversationId: () => string;
  readonly log?: (message: string) => void;
}

/**
 * Bring up the owner-driven activation for whatever is currently stored.
 *
 * A missing credential or fingerprint is a no-op rather than an error: the
 * owner service is the only thing that decides whether a connection should
 * exist, and it reports that state through its own snapshot.
 */
export async function startTelegramConnectionActivation(
  options: StartTelegramConnectionActivationOptions,
): Promise<void> {
  const { store, settingsService } = options;
  const botFingerprint = store.botFingerprint();
  if (botFingerprint === null) return;

  const botToken = settingsService.getEncryptedSecret(TELEGRAM_BOT_TOKEN_SECRET_KEY);
  if (botToken === null) return;

  const digestActor = createTelegramActorDigester({ botFingerprint });
  const controlReplies = createTelegramControlReplySender({
    client: createTelegramBotApiClient({ botToken }),
    ...(options.log ? { log: options.log } : {}),
  });

  await maybeStartTelegramConnectionBridge({
    conversationSurfaceRuntime: options.conversationSurfaceRuntime,
    conversationCommandPort: options.conversationCommandPort,
    getCurrentConversationId: options.getCurrentConversationId,
    botToken,
    botFingerprint,
    authority: {
      activePairingActorDigest: () => store.activePairingActorDigest(),
      resolveActiveApproval: (actorDigest, conversationDigest) =>
        store.resolveActiveApproval(actorDigest, conversationDigest),
      resolveBoundConversation: (actorDigest) => store.resolveBoundConversation(actorDigest),
    },
    pollOffset: () => store.pollOffset(),
    recordPollOffset: (offset) => store.recordPollOffset(offset),
    hasPendingPairingCode: () => store.ownerSnapshot().pendingCode !== null,
    redeemPairingCode: async (codeDigest, senderId) => {
      const actorDigest = digestActor(senderId);
      if (actorDigest === null) return false;
      return await store.completePairing({ codeDigest, actorDigest }) !== null;
    },
    consumePairingAttempt: async () => {
      await store.consumePendingCodeAttempt();
    },
    isPairedOwner: (senderId) => {
      const actorDigest = digestActor(senderId);
      return actorDigest !== null && store.activePairingActorDigest() === actorDigest;
    },
    notifyUnroutable: async (chatId) => {
      await controlReplies.notify(chatId, "conversation-not-shared");
    },
    onFatal: async (code) => {
      await store.setLastError(code);
    },
    ...(options.log ? { log: options.log } : {}),
  });
}

/**
 * The one conversation-digest derivation for this feature, re-exported so the
 * store and the owner service are wired from the same symbol. Two injections of
 * the same function is deliberate: the store compares them on every write, so a
 * future second derivation is refused instead of writing grants nothing can
 * resolve.
 */
export { telegramConversationDigest };

/** Re-exported so `main.ts` composes one conversation-digest derivation. */
export function telegramConversationDigestFor(
  store: TelegramConnectionStore,
  conversationId: string,
): string | null {
  const botFingerprint = store.botFingerprint();
  if (botFingerprint === null) return null;
  try {
    return telegramConversationDigest(botFingerprint, conversationId);
  } catch {
    return null;
  }
}
