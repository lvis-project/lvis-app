import { describe, expect, it, vi } from "vitest";
import {
  createTailnetWebSessionStore,
} from "../tailnet-web-session-store.js";
import type { TailnetPairingShareBinding } from "../../shared/chat-origin.js";
import type { TailnetShareActorId } from "../../main/tailnet-pairing-share-store.js";

const ACTOR = ("tailnet:" + "a".repeat(64)) as TailnetShareActorId;
const BINDING: TailnetPairingShareBinding = Object.freeze({
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingEpoch: 1,
  shareId: "22222222-2222-4222-8222-222222222222",
  shareEpoch: 1,
  scope: "33333333-3333-4333-8333-333333333333",
});

function issue(
  store: ReturnType<typeof createTailnetWebSessionStore>,
) {
  const session = store.issue({ actorId: ACTOR, pairedShare: BINDING });
  if (session === null) throw new Error("expected browser session");
  return session;
}

describe("Tailnet Web session store", () => {
  it("keeps raw cookie and CSRF values out of resolved records", () => {
    let serial = 0;
    const store = createTailnetWebSessionStore({
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, ++serial),
    });

    const issued = issue(store);
    const resolved = store.resolve(issued.cookieToken);

    expect(issued.cookieToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolved).toEqual({
      actorId: ACTOR,
      pairedShare: BINDING,
      expiresAt: 901_000,
    });
    expect(resolved).not.toHaveProperty("cookieToken");
    expect(resolved).not.toHaveProperty("csrfToken");
    expect(JSON.stringify(resolved)).not.toContain(issued.cookieToken);
    expect(JSON.stringify(resolved)).not.toContain(issued.csrfToken);
  });

  it("requires the matching CSRF value for a mutation and revokes immediately", () => {
    const store = createTailnetWebSessionStore({
      randomBytes: (size) => Buffer.alloc(size, 7),
    });
    const issued = issue(store);

    expect(store.resolveMutation(issued.cookieToken, "x".repeat(43))).toBeNull();
    expect(store.resolveMutation(issued.cookieToken, issued.csrfToken)).toMatchObject({
      actorId: ACTOR,
      pairedShare: BINDING,
    });

    store.revoke(issued.cookieToken);
    expect(store.resolve(issued.cookieToken)).toBeNull();
    expect(store.resolveMutation(issued.cookieToken, issued.csrfToken)).toBeNull();
  });

  it("adds independent page CSRFs without invalidating existing tabs", () => {
    let serial = 0;
    const store = createTailnetWebSessionStore({
      maxCsrfTokensPerSession: 2,
      randomBytes: (size) => Buffer.alloc(size, ++serial),
    });
    const first = issue(store);
    const second = store.issuePageCsrf(
      first.cookieToken,
      { actorId: ACTOR, pairedShare: BINDING },
    );
    if (second === null) throw new Error("expected second page CSRF");

    expect(second.cookieToken).toBe(first.cookieToken);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    expect(store.resolveMutation(first.cookieToken, first.csrfToken)).toMatchObject({
      actorId: ACTOR,
    });
    expect(store.resolveMutation(first.cookieToken, second.csrfToken)).toMatchObject({
      actorId: ACTOR,
    });
    expect(store.issuePageCsrf(
      first.cookieToken,
      { actorId: ACTOR, pairedShare: BINDING },
    )).toBeNull();
  });
  it("notifies listeners only when an active session is invalidated", () => {
    const store = createTailnetWebSessionStore();
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);
    const first = issue(store);

    expect(changed).not.toHaveBeenCalled();
    store.revoke(first.cookieToken);
    expect(changed).toHaveBeenCalledTimes(1);
    store.revoke(first.cookieToken);
    expect(changed).toHaveBeenCalledTimes(1);

    const second = issue(store);
    store.clear();
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.revoke(second.cookieToken);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("expires and bounds sessions fail closed", () => {
    let now = 10;
    let serial = 0;
    const store = createTailnetWebSessionStore({
      now: () => now,
      ttlMs: 10,
      maxSessions: 1,
      randomBytes: (size) => Buffer.alloc(size, ++serial),
    });
    const first = issue(store);

    expect(store.issue({ actorId: ACTOR, pairedShare: BINDING })).toBeNull();
    now = 20;
    expect(store.resolve(first.cookieToken)).toBeNull();
    expect(store.issue({ actorId: ACTOR, pairedShare: BINDING })).not.toBeNull();
  });

  it("keeps a pairing entry redeemable but never resolvable as a session", () => {
    let serial = 0;
    const store = createTailnetWebSessionStore({
      randomBytes: (size) => Buffer.alloc(size, ++serial),
    });

    const entry = store.issuePairingEntry();
    if (entry === null) throw new Error("expected pairing entry");

    expect(store.resolvePairingEntryMutation(entry.cookieToken, entry.csrfToken)).toBe(true);
    expect(store.resolvePairingEntryMutation(entry.cookieToken, "x".repeat(43))).toBe(false);
    // A share-less entry carries no authority, so nothing that needs one may
    // accept it — that is the whole reason it is a separate record kind.
    expect(store.resolve(entry.cookieToken)).toBeNull();
    expect(store.resolveMutation(entry.cookieToken, entry.csrfToken)).toBeNull();
    expect(store.issuePageCsrf(entry.cookieToken, { actorId: ACTOR, pairedShare: BINDING })).toBeNull();

    const issued = issue(store);
    expect(store.resolvePairingEntryMutation(issued.cookieToken, issued.csrfToken)).toBe(false);

    store.revoke(entry.cookieToken);
    expect(store.resolvePairingEntryMutation(entry.cookieToken, entry.csrfToken)).toBe(false);
  });

  it("rejects malformed authority and broken random sources", () => {
    const store = createTailnetWebSessionStore();
    expect(store.issue({
      actorId: "tailnet:not-an-actor" as TailnetShareActorId,
      pairedShare: BINDING,
    })).toBeNull();
    expect(store.issue({
      actorId: ACTOR,
      pairedShare: { ...BINDING, pairingEpoch: 0 },
    })).toBeNull();
    expect(() => createTailnetWebSessionStore({
      randomBytes: () => Buffer.alloc(1),
    }).issue({ actorId: ACTOR, pairedShare: BINDING })).toThrow(
      "tailnet-web-session-store-random-invalid",
    );
  });
});
