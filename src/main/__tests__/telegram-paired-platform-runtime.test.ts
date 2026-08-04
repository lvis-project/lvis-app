import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../audit/hmac-chain.js";
import type {
  PlatformBridgeInboundAuthorization,
  PlatformBridgeVerifiedEnvelope,
} from "../platform-bridge-inbound.js";
import {
  createTelegramPairedPlatformRuntime,
  ensureTelegramPlatformActorSecret,
  type TelegramPairedRouteAuthority,
} from "../telegram-platform-runtime.js";

const OWNER_ID = "123456789";
const STRANGER_ID = "987654321";
const BOT_FINGERPRINT = "a".repeat(64);
const CONVERSATION_A = "conversation-a";
const CONVERSATION_B = "conversation-b";

function envelope(senderId = OWNER_ID): PlatformBridgeVerifiedEnvelope {
  return {
    provider: "telegram",
    deliveryId: `telegram-update-${senderId}`,
    channelId: senderId,
    senderId,
    text: "hello from Telegram",
  };
}

/**
 * Mirrors the production derivations so the fixture can name an actor and a
 * conversation the way the durable store would.
 */
function actorDigestFor(actorSecret: string, userId: string): string {
  return createHmac("sha256", actorSecret)
    .update("lvis/telegram-platform-bridge/actor/v1\0", "utf8")
    .update(BOT_FINGERPRINT, "utf8")
    .update("\0", "utf8")
    .update(userId, "utf8")
    .digest("hex");
}

function conversationDigestFor(conversationId: string): string {
  return createHash("sha256")
    .update("lvis/telegram-platform-bridge/conversation/v1\0", "utf8")
    .update(BOT_FINGERPRINT, "utf8")
    .update("\0", "utf8")
    .update(conversationId, "utf8")
    .digest("hex");
}

interface Harness {
  readonly runtime: ReturnType<typeof createTelegramPairedPlatformRuntime>;
  readonly ownerActorDigest: string;
  current: string;
  paired: string | null;
  /** conversationDigest → approval scope, for the paired actor only. */
  readonly approvals: Map<string, string>;
}

function harness(): Harness {
  const secrets = new MemorySecretStore();
  const actorSecret = ensureTelegramPlatformActorSecret(secrets);
  const ownerActorDigest = actorDigestFor(actorSecret, OWNER_ID);
  const state = {
    current: CONVERSATION_A,
    paired: ownerActorDigest as string | null,
    approvals: new Map<string, string>(),
  };
  const authority: TelegramPairedRouteAuthority = {
    activePairingActorDigest: () => state.paired,
    resolveActiveApproval: (actorDigest, conversationDigest) => {
      if (state.paired === null || actorDigest !== state.paired) return null;
      const scope = state.approvals.get(conversationDigest);
      return scope === undefined ? null : { scope };
    },
  };
  const runtime = createTelegramPairedPlatformRuntime({
    botFingerprint: BOT_FINGERPRINT,
    authority,
    getCurrentConversationId: () => state.current,
    activationEpoch: 1,
    secretStore: secrets,
  });
  return {
    runtime,
    ownerActorDigest,
    get current() { return state.current; },
    set current(value: string) { state.current = value; },
    get paired() { return state.paired; },
    set paired(value: string | null) { state.paired = value; },
    approvals: state.approvals,
  };
}

function approve(h: Harness, conversationId: string, scope: string): void {
  h.approvals.set(conversationDigestFor(conversationId), scope);
}

describe("createTelegramPairedPlatformRuntime", () => {
  it("admits nobody until an approval exists, and never a stranger", () => {
    const h = harness();

    // Paired but nothing shared: pairing is identification, not access.
    expect(h.runtime.routeForEnvelope(envelope())).toBeNull();
    expect(h.runtime.authorize(envelope())).toBeNull();

    approve(h, CONVERSATION_A, "scope-a");
    expect(h.runtime.routeForEnvelope(envelope())).not.toBeNull();
    // Positive case above proves the negatives below are not vacuous.
    expect(h.runtime.routeForEnvelope(envelope(STRANGER_ID))).toBeNull();

    h.paired = null;
    expect(h.runtime.routeForEnvelope(envelope())).toBeNull();
  });

  it("binds the route to the conversation that was approved", () => {
    const h = harness();
    approve(h, CONVERSATION_A, "scope-a");

    const route = h.runtime.routeForEnvelope(envelope());
    expect(route?.conversationId).toBe(CONVERSATION_A);
    expect(route?.chatId).toBe(OWNER_ID);
    expect(route?.actorDigest).toBe(h.ownerActorDigest);
    expect(h.runtime.isRouteCurrent(route!)).toBe(true);
  });

  it("does not follow the owner into a conversation they never approved", () => {
    const h = harness();
    approve(h, CONVERSATION_A, "scope-a");
    const route = h.runtime.routeForEnvelope(envelope())!;

    // Switching away pauses the surface rather than re-pointing it.
    h.current = CONVERSATION_B;
    expect(h.runtime.isRouteCurrent(route)).toBe(false);
    expect(h.runtime.routeForEnvelope(envelope())).toBeNull();

    // Switching back resumes the same binding.
    h.current = CONVERSATION_A;
    expect(h.runtime.isRouteCurrent(route)).toBe(true);
  });

  it("fences the bound conversation, not merely the active one", () => {
    const h = harness();
    approve(h, CONVERSATION_A, "scope-a");
    const routeBoundToA = h.runtime.routeForEnvelope(envelope())!;
    expect(h.runtime.isRouteCurrent(routeBoundToA)).toBe(true);

    // The owner moves on: A's approval is revoked and B is approved instead.
    // A fence that asked "is the CURRENT conversation approved?" would answer
    // yes here and keep flushing A's projection into Telegram.
    h.approvals.delete(conversationDigestFor(CONVERSATION_A));
    approve(h, CONVERSATION_B, "scope-b");
    h.current = CONVERSATION_B;

    expect(h.runtime.isRouteCurrent(routeBoundToA)).toBe(false);
  });

  it("mints a distinct route when the owner shares a different conversation", () => {
    const h = harness();
    approve(h, CONVERSATION_A, "scope-a");
    const first = h.runtime.routeForEnvelope(envelope())!;

    h.approvals.delete(conversationDigestFor(CONVERSATION_A));
    approve(h, CONVERSATION_B, "scope-b");
    h.current = CONVERSATION_B;
    const second = h.runtime.routeForEnvelope(envelope())!;

    expect(second).not.toBe(first);
    expect(second.conversationId).toBe(CONVERSATION_B);
    // Same owner and bot, so the durable receipt identity must not move.
    expect(second.actorDigest).toBe(first.actorDigest);
    expect(second.binding.scope).not.toBe(first.binding.scope);
  });

  it("rejects a binding captured before the approval was replaced", () => {
    const h = harness();
    approve(h, CONVERSATION_A, "scope-a");
    const first = h.runtime.routeForEnvelope(envelope())!;
    const staleAuthorization = h.runtime.authorize(envelope()) as PlatformBridgeInboundAuthorization;
    expect(staleAuthorization.bridgeGuard.isCurrent(first.binding)).toBe(true);

    // Re-approving the same conversation under a new scope supersedes it.
    approve(h, CONVERSATION_A, "scope-a2");
    const refreshed = h.runtime.routeForEnvelope(envelope())!;
    expect(refreshed.binding.scope).not.toBe(first.binding.scope);
    expect(staleAuthorization.bridgeGuard.isCurrent(first.binding)).toBe(false);
  });

  it("revokes every route on dispose", () => {
    const h = harness();
    approve(h, CONVERSATION_A, "scope-a");
    const route = h.runtime.routeForEnvelope(envelope())!;

    h.runtime.dispose();
    expect(h.runtime.isRouteCurrent(route)).toBe(false);
    expect(h.runtime.routeForEnvelope(envelope())).toBeNull();
    expect(h.runtime.routes).toEqual([]);
  });

  it("fails closed when the authority throws or the conversation is unreadable", () => {
    const secrets = new MemorySecretStore();
    const throwing: TelegramPairedRouteAuthority = {
      activePairingActorDigest: () => { throw new Error("store unavailable"); },
      resolveActiveApproval: () => { throw new Error("store unavailable"); },
    };
    const runtime = createTelegramPairedPlatformRuntime({
      botFingerprint: BOT_FINGERPRINT,
      authority: throwing,
      getCurrentConversationId: () => CONVERSATION_A,
      activationEpoch: 1,
      secretStore: secrets,
    });
    expect(runtime.routeForEnvelope(envelope())).toBeNull();
    expect(runtime.authorize(envelope())).toBeNull();
  });

  it("rejects an unusable configuration", () => {
    const authority: TelegramPairedRouteAuthority = {
      activePairingActorDigest: () => null,
      resolveActiveApproval: () => null,
    };
    const base = {
      botFingerprint: BOT_FINGERPRINT,
      authority,
      getCurrentConversationId: () => CONVERSATION_A,
      activationEpoch: 1,
      secretStore: new MemorySecretStore(),
    };
    expect(() => createTelegramPairedPlatformRuntime({ ...base, activationEpoch: 0 }))
      .toThrow("telegram-paired-platform-runtime-invalid");
    expect(() => createTelegramPairedPlatformRuntime({
      ...base,
      botFingerprint: BOT_FINGERPRINT.toUpperCase(),
    })).toThrow("telegram-paired-platform-runtime-invalid");
    expect(() => createTelegramPairedPlatformRuntime({
      ...base,
      authority: {} as unknown as TelegramPairedRouteAuthority,
    })).toThrow("telegram-paired-platform-runtime-invalid");
  });
});
