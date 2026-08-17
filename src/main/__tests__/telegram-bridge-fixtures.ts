/**
 * Shared fixtures for the Telegram bridge suites. The lifecycle suite
 * (`telegram-bridge-server.test.ts`, mocked projection store) and the egress
 * integration suite (`telegram-egress.integration.test.ts`, real projection
 * chain) drive the same owner-driven connection entry, so the paired-owner
 * identities, the polled text-update wire shape, and the route authority live
 * here once instead of drifting as per-file copies.
 */
import type { SecretStore } from "../../audit/hmac-chain.js";
import type { TelegramBotApiResult, TelegramPolledUpdate } from "../telegram-bot-api-client.js";
import {
  createTelegramActorDigester,
  telegramConversationDigest,
  type TelegramPairedRouteAuthority,
} from "../telegram-platform-runtime.js";

export const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDEF";
export const BOT_FINGERPRINT = "a".repeat(64);
export const OWNER_CHAT_ID = "123456789";
export const BOUND_CONVERSATION = "active-conversation";

export type Batch = TelegramBotApiResult<readonly TelegramPolledUpdate[]>;

/** One polled private text update from the paired owner, as raw wire bytes. */
export function textUpdate(updateId: number, text: string): TelegramPolledUpdate {
  return {
    updateId,
    rawBody: Buffer.from(JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId + 1,
        date: 1_700_000_000,
        from: { id: Number(OWNER_CHAT_ID), is_bot: false },
        chat: { id: Number(OWNER_CHAT_ID), type: "private" },
        text,
      },
    }), "utf8"),
  };
}

/**
 * Build the authority a completed owner pairing leaves behind: the digester
 * and runtime must read the SAME secret store so the actor digest agrees, and
 * the owner digest is paired to the bound conversation with a live approval.
 */
export function ownerPairedAuthority(secretStore: SecretStore): {
  readonly ownerDigest: string;
  readonly authority: TelegramPairedRouteAuthority;
} {
  const digester = createTelegramActorDigester({ botFingerprint: BOT_FINGERPRINT, secretStore });
  const ownerDigest = digester.digestFor(OWNER_CHAT_ID);
  if (ownerDigest === null) throw new Error("fixture-owner-digest");
  const conversationDigest = telegramConversationDigest(BOT_FINGERPRINT, BOUND_CONVERSATION);
  const authority: TelegramPairedRouteAuthority = {
    activePairingActorDigest: () => ownerDigest,
    resolveActiveApproval: (actorDigest, digest) =>
      actorDigest === ownerDigest && digest === conversationDigest
        ? { scope: "1e7d0f3a-0000-4000-8000-00000000a003" }
        : null,
    resolveBoundConversation: (actorDigest) =>
      actorDigest === ownerDigest ? BOUND_CONVERSATION : null,
  };
  return { ownerDigest, authority };
}
