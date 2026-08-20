import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import {
  createTailnetPairingShareStore,
  type TailnetShareActorId,
} from "../tailnet-pairing-share-store.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const ACTOR = ("tailnet:" + "a".repeat(64)) as TailnetShareActorId;
const OTHER_ACTOR = ("tailnet:" + "b".repeat(64)) as TailnetShareActorId;
const CONVERSATION = "private-session-id-must-not-persist";
const OTHER_CONVERSATION = "different-private-session-id";

let directories: string[] = [];

afterEach(async () => {
  for (const directory of directories) await cleanupTmpDir(directory);
  directories = [];
});

function namespace(directory: string): FeatureNamespaceHandle {
  return {
    get dir(): string {
      return directory;
    },
    async readJson<T>(_name: string, fallback: T): Promise<T> {
      return fallback;
    },
    async writeJson<T>(name: string, value: T): Promise<void> {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", "utf8");
    },
    async childDir(name: string): Promise<string> {
      const child = join(directory, name);
      mkdirSync(child, { recursive: true, mode: 0o700 });
      return child;
    },
  };
}

async function makeStore(nowRef: { value: number }) {
  const directory = mkdtempSync(join(tmpdir(), "lvis-tailnet-sharing-"));
  directories.push(directory);
  const store = createTailnetPairingShareStore({
    namespace: namespace(directory),
    now: () => nowRef.value,
  });
  await store.open();
  return { store, directory };
}

async function activePairing(
  store: ReturnType<typeof createTailnetPairingShareStore>,
  actor = ACTOR,
): Promise<string> {
  const invitation = await store.createInvitation();
  const claim = await store.claimInvitation(invitation.code, actor);
  expect(claim).not.toBeNull();
  expect(await store.activatePairing(claim!.pairingId)).toBe(true);
  return claim!.pairingId;
}

describe("TailnetPairingShareStore", () => {
  it("keeps pairing distinct from conversation authority and never persists raw invite or conversation values", async () => {
    const now = { value: 10_000 };
    const { store, directory } = await makeStore(now);
    const invitation = await store.createInvitation();
    const claim = await store.claimInvitation(invitation.code, ACTOR);

    expect(claim).not.toBeNull();
    expect(store.resolveActiveShare(ACTOR, CONVERSATION, "observe")).toBeNull();
    expect(await store.activatePairing(claim!.pairingId)).toBe(true);
    expect(store.resolveActiveShare(ACTOR, CONVERSATION, "observe")).toBeNull();

    const share = await store.createShare({
      pairingId: claim!.pairingId,
      conversationId: CONVERSATION,
    });
    expect(share).toMatchObject({
      actorId: ACTOR,
      permission: "observe",
      pairing: {
        pairingId: claim!.pairingId,
        pairingEpoch: 1,
        shareEpoch: 1,
        scope: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      },
    });
    expect(store.resolveActiveShare(ACTOR, CONVERSATION, "observe")).toMatchObject({
      pairing: share!.pairing,
    });
    expect(store.resolveActiveShare(ACTOR, CONVERSATION, "control")).toBeNull();
    expect(store.resolveActiveShare(ACTOR, OTHER_CONVERSATION, "observe")).toBeNull();

    const persisted = readFileSync(join(directory, "pairing-share.json"), "utf8");
    expect(persisted).not.toContain(invitation.code);
    expect(persisted).not.toContain(CONVERSATION);
    expect(persisted).not.toContain(OTHER_CONVERSATION);
    expect(persisted).not.toContain("owner@example.com");
  });

  it("uses an invite once, does not let an account create duplicate pending pairings, and expires claims", async () => {
    const now = { value: 50_000 };
    const { store } = await makeStore(now);
    const invitation = await store.createInvitation(100);
    const first = await store.claimInvitation(invitation.code, ACTOR);

    expect(first).not.toBeNull();
    expect(await store.claimInvitation(invitation.code, OTHER_ACTOR)).toBeNull();
    expect(await store.claimInvitation(invitation.code, ACTOR)).toBeNull();

    const secondInvitation = await store.createInvitation(100);
    expect(await store.claimInvitation(secondInvitation.code, ACTOR)).toBeNull();

    now.value += 101;
    const expiredInvitation = await store.createInvitation(100);
    now.value += 101;
    expect(await store.claimInvitation(expiredInvitation.code, OTHER_ACTOR)).toBeNull();
  });

  it("replaces an old public scope, applies control as a separate share grant, and makes old bindings fail closed", async () => {
    const now = { value: 90_000 };
    const { store } = await makeStore(now);
    const pairingId = await activePairing(store);
    const observe = await store.createShare({
      pairingId,
      conversationId: CONVERSATION,
      permission: "observe",
    });
    expect(observe).not.toBeNull();

    const control = await store.createShare({
      pairingId,
      conversationId: CONVERSATION,
      permission: "control",
    });
    expect(control).not.toBeNull();
    expect(control!.pairing.scope).not.toBe(observe!.pairing.scope);
    expect(store.isAuthorityCurrent(observe!, CONVERSATION, "observe")).toBe(false);
    expect(store.isAuthorityCurrent(control!, CONVERSATION, "control")).toBe(true);
    expect(store.resolveActiveShare(ACTOR, CONVERSATION, "control")).toMatchObject({
      pairing: control!.pairing,
    });

    expect(await store.revokeShare(control!.pairing.shareId)).toBe(true);
    expect(store.isAuthorityCurrent(control!, CONVERSATION, "control")).toBe(false);
    expect(await store.revokeShare(control!.pairing.shareId)).toBe(false);
  });

  it("atomically revokes every share when a pairing is revoked and emits a recheck signal after durable mutation", async () => {
    const now = { value: 130_000 };
    const { store } = await makeStore(now);
    const pairingId = await activePairing(store);
    const first = await store.createShare({
      pairingId,
      conversationId: CONVERSATION,
      permission: "control",
    });
    const second = await store.createShare({
      pairingId,
      conversationId: OTHER_CONVERSATION,
      permission: "observe",
    });
    let changes = 0;
    const unsubscribe = store.subscribe(() => {
      changes += 1;
    });

    expect(await store.revokePairing(pairingId)).toBe(true);
    unsubscribe();

    expect(changes).toBe(1);
    expect(store.isAuthorityCurrent(first!, CONVERSATION, "control")).toBe(false);
    expect(store.isAuthorityCurrent(second!, OTHER_CONVERSATION, "observe")).toBe(false);
    expect(store.resolveActiveShare(ACTOR, CONVERSATION, "observe")).toBeNull();
    expect(store.ownerSnapshot().shares).toEqual([]);
  });

  it("round-trips valid durable state and fails closed for a corrupt file", async () => {
    const now = { value: 200_000 };
    const directory = mkdtempSync(join(tmpdir(), "lvis-tailnet-sharing-persist-"));
    directories.push(directory);
    const first = createTailnetPairingShareStore({
      namespace: namespace(directory),
      now: () => now.value,
    });
    await first.open();
    const pairingId = await activePairing(first);
    const authority = await first.createShare({
      pairingId,
      conversationId: CONVERSATION,
      permission: "control",
    });
    expect(authority).not.toBeNull();

    const restored = createTailnetPairingShareStore({
      namespace: namespace(directory),
      now: () => now.value,
    });
    await restored.open();
    expect(restored.isAuthorityCurrent(authority!, CONVERSATION, "control")).toBe(true);

    writeFileSync(join(directory, "pairing-share.json"), "{not-json", "utf8");
    const corrupt = createTailnetPairingShareStore({
      namespace: namespace(directory),
      now: () => now.value,
    });
    await expect(corrupt.open()).rejects.toThrow("tailnet-pairing-share-store-invalid");
  });
});
