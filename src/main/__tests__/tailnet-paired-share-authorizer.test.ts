import { describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../audit/hmac-chain.js";
import type { TailnetPairingShareAuthority } from "../tailnet-pairing-share-store.js";
import {
  createTailnetPairedShareAuthorizer,
  ensureTailnetPairedShareActorSecret,
  TAILNET_PAIRED_SHARE_ACTOR_SECRET_NAME,
  type TailnetPairedShareStore,
  ACTOR_SECRET_BYTES,
  ACTOR_SECRET_PATTERN,
} from "../tailnet-paired-share-authorizer.js";

const BINDING = Object.freeze({
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingEpoch: 1,
  shareId: "22222222-2222-4222-8222-222222222222",
  shareEpoch: 1,
  scope: "33333333-3333-4333-8333-333333333333",
});

describe("TailnetPairedShareAuthorizer", () => {
  it("creates a stable opaque actor id from an encrypted-store secret", () => {
    const secrets = new MemorySecretStore();
    const first = ensureTailnetPairedShareActorSecret(secrets);
    const second = ensureTailnetPairedShareActorSecret(secrets);
    expect(first).toBe(second);
    expect(secrets.read(TAILNET_PAIRED_SHARE_ACTOR_SECRET_NAME, 128)).toBe(first);

    const authorizer = createTailnetPairedShareAuthorizer({
      store: inertStore(),
      actorSecret: first,
      getCurrentConversationId: () => "conversation-a",
    });
    const actor = authorizer.actorIdFor("owner@example.test");
    expect(actor).toMatch(/^tailnet:[a-f0-9]{64}$/);
    expect(actor).not.toContain("owner");
    expect(authorizer.actorIdFor("owner@example.test")).toBe(actor);
    expect(authorizer.actorIdFor("other@example.test")).not.toBe(actor);
  });

  it("requires a current scoped grant and rechecks it at the final boundary", () => {
    const current = { conversationId: "conversation-a" };
    let authoritative = true;
    let expectedActor = "";
    const store: TailnetPairedShareStore = {
      subscribe: () => () => {},
      resolveActiveShare(actorId, conversationId, required): TailnetPairingShareAuthority | null {
        if (actorId !== expectedActor || conversationId !== "conversation-a" || required !== "control") {
          return null;
        }
        return { actorId, pairing: BINDING, permission: "control" };
      },
      isAuthorityCurrent(authority, conversationId, required): boolean {
        return authoritative
          && authority.actorId === expectedActor
          && conversationId === "conversation-a"
          && required === "control";
      },
    };
    const authorizer = createTailnetPairedShareAuthorizer({
      store,
      actorSecret: "a".repeat(43),
      getCurrentConversationId: () => current.conversationId,
    });
    expectedActor = authorizer.actorIdFor("owner@example.test")!;

    const grant = authorizer.authorize("owner@example.test", "conversation-a", "control");
    expect(grant).not.toBeNull();
    expect(grant?.pairedShareGuard.isCurrent(grant.pairedShare!)).toBe(true);

    authoritative = false;
    expect(grant?.pairedShareGuard.isCurrent(grant.pairedShare!)).toBe(false);

    authoritative = true;
    current.conversationId = "conversation-b";
    expect(grant?.pairedShareGuard.isCurrent(grant.pairedShare!)).toBe(false);
  });

  it("fails closed for malformed login, bad secret, and an unavailable grant", () => {
    expect(() => createTailnetPairedShareAuthorizer({
      store: inertStore(),
      actorSecret: "not-a-valid-secret",
      getCurrentConversationId: () => "conversation-a",
    })).toThrow("tailnet-paired-share-authorizer-invalid");

    const authorizer = createTailnetPairedShareAuthorizer({
      store: inertStore(),
      actorSecret: "b".repeat(43),
      getCurrentConversationId: () => "conversation-a",
    });
    expect(authorizer.actorIdFor("")).toBeNull();
    expect(authorizer.actorIdFor("hello\nworld")).toBeNull();
    expect(authorizer.authorize("owner@example.test", "conversation-a", "observe")).toBeNull();
  });

  it("rejects a corrupted persisted actor secret rather than silently rotating it", () => {
    const secrets = new MemorySecretStore();
    secrets.write(TAILNET_PAIRED_SHARE_ACTOR_SECRET_NAME, "short");
    expect(() => ensureTailnetPairedShareActorSecret(secrets))
      .toThrow("tailnet-paired-share-actor-secret-invalid");
  });
});

function inertStore(): TailnetPairedShareStore {
  return {
    subscribe: () => () => {},
    resolveActiveShare: () => null,
    isAuthorityCurrent: () => false,
  };
}

describe("actor secret shape", () => {
  it("is 32 random bytes as unpadded base64url — 43 characters", () => {
    expect(ACTOR_SECRET_BYTES).toBe(32);
    expect(ACTOR_SECRET_PATTERN.test(Buffer.alloc(ACTOR_SECRET_BYTES, 7).toString("base64url"))).toBe(true);
    expect(ACTOR_SECRET_PATTERN.test(Buffer.alloc(ACTOR_SECRET_BYTES, 7).toString("base64"))).toBe(false);
  });
});
