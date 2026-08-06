/**
 * Composition glue between the owner's durable connection state and the
 * bridge activation.
 *
 * It exists so `main.ts` does not have to know how a stored pairing becomes an
 * egress authority, and so the credential is read at activation time from the
 * encrypted store rather than being held anywhere longer-lived.
 */
import type { SecretStore } from "../audit/hmac-chain.js";
import type { ConversationSurfaceRuntime } from "../engine/conversation-surface-runtime.js";
import type { ConversationCommandPort } from "./conversation-command-port.js";
import { createTelegramBotApiClient } from "./telegram-bot-api-client.js";
import { maybeStartTelegramConnectionBridge } from "./telegram-bridge-server.js";
import {
  createTelegramControlReplySender,
  type TelegramControlNotice,
  type TelegramControlReplySender,
} from "./telegram-control-reply.js";
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
  /**
   * Stops this activation. Wired to the same owner-initiated teardown the
   * settings surface uses, so a fatal poll outcome and a manual disconnect
   * converge on one path.
   */
  readonly stopBridge: () => Promise<void>;
  /** Test-only injection; production reads Electron's OS-encrypted store. */
  readonly secretStore?: SecretStore;
  readonly log?: (message: string) => void;
}

/**
 * The composed answer to "this refusal deserves a word back".
 *
 * Extracted because the bug it replaces was invisible everywhere else. The
 * ingress decides WHICH notice a refusal earns — "nothing is shared" and
 * "commands are not supported" are different problems with different repairs —
 * and passes it as the second argument. This binding was written taking only
 * the chat id, so the notice was dropped and every refusal was answered with a
 * hardcoded "nothing is shared". An owner mid-share who sent a slash command
 * was told, falsely, that they had shared nothing.
 *
 * Nothing caught it: a callback declared with fewer parameters than it is
 * handed is not a type error, and the ingress suite injects its own notifier,
 * so its assertions never reached this composition. Making the binding a named
 * function gives that seam somewhere to be tested.
 */
export function createUnroutableNotifier(
  controlReplies: Pick<TelegramControlReplySender, "notify">,
): (chatId: string, notice: TelegramControlNotice) => Promise<void> {
  return async (chatId, notice) => {
    await controlReplies.notify(chatId, notice);
  };
}

/**
 * Name this machine's actor key to the durable store, and let it retire a
 * pairing that key can no longer derive.
 *
 * Separate from {@link startTelegramConnectionActivation} because of WHEN it has
 * to run rather than what it does. The bot token and the actor key live in the
 * same OS credential store, so the ordinary real failure — a keychain reset —
 * takes both; an activation that reads the credential first never gets here at
 * all, and the owner surface, which reads the store rather than the bridge,
 * goes on claiming an account nothing on this machine can name. The connection
 * service owns that ordering and calls this ahead of its own credential read.
 *
 * A store with no bot identity is a no-op: no digest could have been minted
 * under an older key yet, and adopting a name here would be adopting one for a
 * document that has nothing to lose.
 */
export async function reconcileTelegramActorKey(options: {
  readonly store: TelegramConnectionStore;
  /** Test-only injection; production reads Electron's OS-encrypted store. */
  readonly secretStore?: SecretStore;
}): Promise<void> {
  const botFingerprint = options.store.botFingerprint();
  if (botFingerprint === null) return;
  const digestActor = createTelegramActorDigester({
    botFingerprint,
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
  });
  await options.store.reconcileActorKey(digestActor.actorKeyDigest);
}

/**
 * Bring up the owner-driven activation for whatever is currently stored.
 *
 * A missing credential or fingerprint is a no-op rather than an error: the
 * owner service is the only thing that decides whether a connection should
 * exist, and it reports that state through its own snapshot.
 *
 * The actor-key reconcile is deliberately NOT done here. It has to precede the
 * credential read, and this function is only ever reached after the service has
 * already made one — see {@link reconcileTelegramActorKey}.
 */
export async function startTelegramConnectionActivation(
  options: StartTelegramConnectionActivationOptions,
): Promise<void> {
  const { store, settingsService } = options;
  const botFingerprint = store.botFingerprint();
  if (botFingerprint === null) return;

  const digestActor = createTelegramActorDigester({
    botFingerprint,
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
  });

  const botToken = settingsService.getEncryptedSecret(TELEGRAM_BOT_TOKEN_SECRET_KEY);
  if (botToken === null) return;

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
    ...(options.secretStore ? { secretStore: options.secretStore } : {}),
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
      const actorDigest = digestActor.digestFor(senderId);
      if (actorDigest === null) return false;
      return await store.completePairing({ codeDigest, actorDigest }) !== null;
    },
    isPairedOwner: (senderId) => {
      const actorDigest = digestActor.digestFor(senderId);
      return actorDigest !== null && store.activePairingActorDigest() === actorDigest;
    },
    notifyUnroutable: createUnroutableNotifier(controlReplies),
    onFatal: async (code) => {
      // Best-effort, and deliberately not allowed to skip the teardown below.
      // One fatal code says the store itself cannot be written, so the call
      // that records it is the one most likely to throw — and a throw here used
      // to abandon the teardown, leaving egress attached for exactly the
      // failure that needs it detached most.
      try {
        await store.setLastError(code);
      } catch {
        options.log?.("[telegram-activation] the fatal poll outcome could not be recorded");
      }
      // A fatal poll outcome ends ingress but left egress attached, so a bridge
      // showing an error badge kept streaming assistant text to the phone.
      // Tear the activation down: a surface that cannot receive must not send.
      //
      // Deliberately not awaited. This handler runs inside the poll loop and the
      // teardown waits for that loop to finish, so awaiting here would leave each
      // side waiting on the other. Starting it and returning lets the loop unwind
      // into the stop that is already in flight.
      void options.stopBridge().catch(() => {
        options.log?.("[telegram-activation] teardown after a fatal poll failed");
      });
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
