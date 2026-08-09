import { afterEach, describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import {
  createTelegramConnectionStore,
  type TelegramConnectionStore,
} from "../telegram-connection-store.js";
import { conversationDigestFor, namespaceAt } from "./telegram-connection-namespace.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

/**
 * Distinct raw values that must never reach the file. Each one is what the
 * bridge actually handles at runtime; the store only ever sees a digest of it.
 */
const RAW_BOT_TOKEN = "8112233445:SENTINEL-bot-token-value-never-persisted";
const RAW_TELEGRAM_USER_ID = "776655443322";
const RAW_CHAT_ID = "-1009988776655";
const RAW_CONVERSATION_ID = "sentinel-conversation-b41f-never-persisted";
const OTHER_CONVERSATION_ID = "sentinel-other-conversation-9ac2";
const RAW_PAIRING_CODE = "lvis-tg-v1.SENTINELrawPairingCode0123456789abcdefghijk";

const FILE_NAME = "connection.json";
const HOUR_MS = 60 * 60 * 1_000;

let directories: string[] = [];

afterEach(async () => {
  for (const directory of directories) await cleanupTmpDir(directory);
  directories = [];
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lvis-telegram-connection-"));
  directories.push(directory);
  return directory;
}


function hash(domain: string, value: string): string {
  return createHash("sha256").update(domain, "utf8").update("\0", "utf8")
    .update(value, "utf8").digest("hex");
}

/** Mirrors telegram-platform-runtime: HMAC over a secret, never the raw ids. */
function actorDigestFor(userId: string): string {
  return createHmac("sha256", "test-actor-secret")
    .update("lvis/telegram-platform-bridge/actor/v1\0", "utf8")
    .update(hash("bot", RAW_BOT_TOKEN), "utf8").update("\0", "utf8")
    .update(userId, "utf8").digest("hex");
}

const BOT_FINGERPRINT = hash("bot", RAW_BOT_TOKEN);
const OTHER_BOT_FINGERPRINT = hash("bot", "9998887776:a-different-bot-token");
const ACTOR = actorDigestFor(RAW_TELEGRAM_USER_ID);
const OTHER_ACTOR = actorDigestFor("111222333444");
/** Stands in for the platform runtime's digest of the durable actor key. */
const ACTOR_KEY_DIGEST = hash("actor-key", "the-actor-key-this-machine-can-load");
const OTHER_ACTOR_KEY_DIGEST = hash("actor-key", "the-key-a-restored-machine-mints-instead");
const CODE_DIGEST = hash("code", RAW_PAIRING_CODE);
const WRONG_CODE_DIGEST = hash("code", "lvis-tg-v1.someOtherWellFormedCandidateValue0123456789ab");
const CONVERSATION = conversationDigestFor(BOT_FINGERPRINT, RAW_CONVERSATION_ID);
const OTHER_CONVERSATION = conversationDigestFor(BOT_FINGERPRINT, OTHER_CONVERSATION_ID);

function openStore(
  directory: string,
  clock: { value: number },
  overrides: { readonly namespace?: FeatureNamespaceHandle; readonly randomUuid?: () => string } = {},
): Promise<TelegramConnectionStore> {
  const store = createTelegramConnectionStore({
    namespace: overrides.namespace ?? namespaceAt(directory),
    now: () => clock.value,
    conversationDigestFor,
    ...(overrides.randomUuid === undefined ? {} : { randomUuid: overrides.randomUuid }),
  });
  return store.open().then(() => store);
}

/** connect → mint → redeem → approve, the whole owner-driven happy path. */
async function connectedAndApproved(
  store: TelegramConnectionStore,
  options: { readonly ttlMs?: number; readonly conversationId?: string } = {},
): Promise<void> {
  await store.setConnected(BOT_FINGERPRINT);
  await store.createPendingCode({ codeDigest: CODE_DIGEST });
  const pairing = await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest: ACTOR });
  expect(pairing).not.toBeNull();
  const conversationId = options.conversationId ?? RAW_CONVERSATION_ID;
  const approval = await store.createApproval({
    conversationId,
    conversationDigest: conversationDigestFor(BOT_FINGERPRINT, conversationId),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  expect(approval).not.toBeNull();
}

function readText(directory: string): string {
  return readFileSync(join(directory, FILE_NAME), "utf8");
}

interface PersistedApproval {
  conversationId: string;
  conversationDigest: string;
}

function readDocument(directory: string): { approvals: PersistedApproval[] } {
  return JSON.parse(readText(directory)) as { approvals: PersistedApproval[] };
}

const PAIRING_ID = "11111111-1111-4111-8111-111111111111";
const APPROVAL_ID = "22222222-2222-4222-9222-222222222222";
const SCOPE_ID = "33333333-3333-4333-a333-333333333333";
const OWNER_ID = "44444444-4444-4444-b444-444444444444";

/** A hand-built document: the only way to express a stale-epoch approval. */
function documentWithApprovalEpoch(pairingEpoch: number): Record<string, unknown> {
  return {
    version: 1,
    receiptOwnerId: OWNER_ID,
    activationEpoch: 3,
    desiredState: "connected",
    botFingerprint: BOT_FINGERPRINT,
    actorKeyDigest: ACTOR_KEY_DIGEST,
    pollOffset: 42,
    pendingCode: null,
    pairing: {
      id: PAIRING_ID,
      actorDigest: ACTOR,
      state: "active",
      epoch: 2,
      createdAt: 500_000,
    },
    approvals: [{
      id: APPROVAL_ID,
      pairingId: PAIRING_ID,
      pairingEpoch,
      conversationId: RAW_CONVERSATION_ID,
      conversationDigest: CONVERSATION,
      scope: SCOPE_ID,
      state: "active",
      epoch: 1,
      createdAt: 500_000,
      expiresAt: 5_000_000,
    }],
    lastErrorCode: null,
  };
}

function writeDocument(directory: string, value: unknown): void {
  writeFileSync(join(directory, FILE_NAME), JSON.stringify(value, null, 2) + "\n", "utf8");
}

describe("createTelegramConnectionStore", () => {
  it("round-trips durable state through a real file so a second instance sees it", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const first = await openStore(directory, clock);
    await connectedAndApproved(first);
    await first.recordPollOffset(9_001);
    await first.setLastError("telegram-poll-conflict");

    const reopened = await openStore(directory, clock);
    expect(reopened.receiptOwnerId()).toBe(first.receiptOwnerId());
    expect(reopened.activationEpoch()).toBe(first.activationEpoch());
    expect(reopened.desiredState()).toBe("connected");
    expect(reopened.botFingerprint()).toBe(BOT_FINGERPRINT);
    expect(reopened.pollOffset()).toBe(9_001);
    expect(reopened.ownerSnapshot()).toEqual(first.ownerSnapshot());
    expect(reopened.ownerSnapshot().pairing?.accountFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(reopened.ownerSnapshot().lastErrorCode).toBe("telegram-poll-conflict");
    expect(reopened.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
  });

  it("charges exactly one attempt per wrong digest and destroys the code at zero", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const store = await openStore(directory, clock);
    await store.setConnected(BOT_FINGERPRINT);
    await store.createPendingCode({ codeDigest: CODE_DIGEST, maxAttempts: 2 });

    expect(await store.completePairing({ codeDigest: WRONG_CODE_DIGEST, actorDigest: ACTOR }))
      .toBeNull();
    expect(store.ownerSnapshot().pendingCode?.attemptsRemaining).toBe(1);
    expect(store.ownerSnapshot().pairing).toBeNull();

    expect(await store.completePairing({ codeDigest: WRONG_CODE_DIGEST, actorDigest: ACTOR }))
      .toBeNull();
    expect(store.ownerSnapshot().pendingCode).toBeNull();

    // The budget is spent, so even the correct digest is worthless now.
    expect(await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest: ACTOR })).toBeNull();
    expect(store.ownerSnapshot().pairing).toBeNull();

    // Positive control: a freshly minted code still pairs on the first try.
    await store.createPendingCode({ codeDigest: CODE_DIGEST, maxAttempts: 2 });
    expect(await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest: ACTOR }))
      .toMatchObject({ actorDigest: ACTOR, epoch: 1 });
    expect(store.ownerSnapshot().pendingCode).toBeNull();
  });

  it("charges an attempt for a candidate rejected before digest comparison", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await store.setConnected(BOT_FINGERPRINT);
    await store.createPendingCode({ codeDigest: CODE_DIGEST, maxAttempts: 3 });

    expect(await store.consumePendingCodeAttempt()).toMatchObject({ attemptsRemaining: 2 });
    expect(await store.consumePendingCodeAttempt()).toMatchObject({ attemptsRemaining: 1 });
    expect(await store.consumePendingCodeAttempt()).toBeNull();
    expect(store.ownerSnapshot().pendingCode).toBeNull();
    expect(await store.consumePendingCodeAttempt()).toBeNull();
    expect(await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest: ACTOR })).toBeNull();
  });

  it("does not redeem an expired pending code", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await store.setConnected(BOT_FINGERPRINT);
    await store.createPendingCode({ codeDigest: CODE_DIGEST, ttlMs: 60_000 });

    clock.value += 60_001;
    expect(store.ownerSnapshot().pendingCode).toBeNull();
    expect(await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest: ACTOR })).toBeNull();
    expect(store.ownerSnapshot().pairing).toBeNull();

    // Positive control: the same code inside its window does redeem.
    await store.createPendingCode({ codeDigest: CODE_DIGEST, ttlMs: 60_000 });
    clock.value += 59_999;
    expect(await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest: ACTOR }))
      .not.toBeNull();
  });

  it("resolves an approval only for the exact live actor and conversation", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store, { ttlMs: HOUR_MS });

    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toMatchObject({
      actorDigest: ACTOR,
      conversationDigest: CONVERSATION,
      pairingEpoch: 1,
      approvalEpoch: 1,
    });
    expect(store.resolveActiveApproval(OTHER_ACTOR, CONVERSATION)).toBeNull();
    expect(store.resolveActiveApproval(ACTOR, OTHER_CONVERSATION)).toBeNull();

    const approvalId = store.ownerSnapshot().approval?.id;
    expect(approvalId).toBeDefined();
    expect(await store.revokeApproval(approvalId!)).toBe(true);
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    expect(store.ownerSnapshot().approval).toBeNull();

    await store.createApproval({
      conversationId: RAW_CONVERSATION_ID,
      conversationDigest: CONVERSATION,
      ttlMs: HOUR_MS,
    });
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
    clock.value += HOUR_MS;
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    expect(store.ownerSnapshot().approval).toBeNull();
  });

  it("does not resolve an approval minted under a superseded pairing epoch", async () => {
    const clock = { value: 1_000_000 };
    const current = tempDirectory();
    writeDocument(current, documentWithApprovalEpoch(2));
    const live = await openStore(current, clock);
    // Positive control: the identical document with the current epoch resolves.
    expect(live.resolveActiveApproval(ACTOR, CONVERSATION)).toMatchObject({ pairingEpoch: 2 });

    const stale = tempDirectory();
    writeDocument(stale, documentWithApprovalEpoch(1));
    const superseded = await openStore(stale, clock);
    expect(superseded.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    expect(superseded.ownerSnapshot().approval).toBeNull();
    // The pairing itself survives; only its stale grant died.
    expect(superseded.ownerSnapshot().pairing?.id).toBe(PAIRING_ID);
  });

  it("makes every approval unresolvable once the pairing is revoked", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store);
    const pairingId = store.ownerSnapshot().pairing?.id;
    expect(pairingId).toBeDefined();

    expect(await store.revokePairing(pairingId!)).toBe(true);
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    expect(store.ownerSnapshot().pairing).toBeNull();
    expect(store.ownerSnapshot().approval).toBeNull();
    expect(await store.revokePairing(pairingId!)).toBe(false);
    expect(await store.createApproval({
      conversationId: RAW_CONVERSATION_ID,
      conversationDigest: CONVERSATION,
    })).toBeNull();

    // Re-pairing the same account starts a later epoch, never the old one.
    await store.createPendingCode({ codeDigest: CODE_DIGEST });
    const repaired = await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest: ACTOR });
    expect(repaired?.epoch).toBe(3);
    expect(repaired?.id).not.toBe(pairingId);
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
  });

  it("does not resolve an approval while the bridge is paused", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store);

    expect(await store.setPaused()).toBe(true);
    expect(store.desiredState()).toBe("paused");
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();

    await store.setConnected(BOT_FINGERPRINT);
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
  });

  it("clears pairing, approvals, pending code and poll offset on disconnect", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const store = await openStore(directory, clock);
    await connectedAndApproved(store);
    await store.recordPollOffset(4_242);
    await store.createPendingCode({ codeDigest: CODE_DIGEST });
    const beforeEpoch = store.activationEpoch();
    const ownerId = store.receiptOwnerId();

    await store.setDisconnected();
    expect(store.desiredState()).toBe("disconnected");
    expect(store.activationEpoch()).toBe(beforeEpoch + 1);
    expect(store.pollOffset()).toBeNull();
    expect(store.ownerSnapshot().pairing).toBeNull();
    expect(store.ownerSnapshot().approval).toBeNull();
    expect(store.ownerSnapshot().pendingCode).toBeNull();
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    // The receipt owner identity is the one thing that survives an activation.
    expect(store.receiptOwnerId()).toBe(ownerId);

    const reopened = await openStore(directory, clock);
    expect(reopened.ownerSnapshot().pairing).toBeNull();
    expect(reopened.receiptOwnerId()).toBe(ownerId);
    expect(reopened.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
  });

  it("drops pairing state when a different bot is connected but keeps it on reconnect", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store);
    await store.recordPollOffset(77);

    await store.setConnected(BOT_FINGERPRINT);
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
    expect(store.pollOffset()).toBe(77);

    await store.setConnected(OTHER_BOT_FINGERPRINT);
    expect(store.botFingerprint()).toBe(OTHER_BOT_FINGERPRINT);
    expect(store.ownerSnapshot().pairing).toBeNull();
    expect(store.pollOffset()).toBeNull();
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
  });

  it("never moves the poll offset backwards", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const store = await openStore(directory, clock);
    await store.recordPollOffset(500);
    await store.recordPollOffset(700);
    await store.recordPollOffset(699);
    await store.recordPollOffset(0);
    expect(store.pollOffset()).toBe(700);

    const reopened = await openStore(directory, clock);
    expect(reopened.pollOffset()).toBe(700);
    await expect(reopened.recordPollOffset(-1)).rejects.toThrow(
      "telegram-connection-store-input-invalid",
    );
    expect(reopened.pollOffset()).toBe(700);
  });

  it("reads a corrupted or unknown-shaped file as a disconnected store", async () => {
    const clock = { value: 1_700_000_000_000 };
    const truncated = tempDirectory();
    writeFileSync(join(truncated, FILE_NAME), "{\"version\": 1, \"pairing\":", "utf8");
    const fromCorrupt = await openStore(truncated, clock);
    expect(fromCorrupt.desiredState()).toBe("disconnected");
    expect(fromCorrupt.ownerSnapshot().pairing).toBeNull();
    expect(fromCorrupt.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();

    const widened = tempDirectory();
    writeDocument(widened, { ...documentWithApprovalEpoch(2), unexpectedField: true });
    const fromWidened = await openStore(widened, clock);
    expect(fromWidened.desiredState()).toBe("disconnected");
    expect(fromWidened.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();

    const wrongVersion = tempDirectory();
    writeDocument(wrongVersion, { ...documentWithApprovalEpoch(2), version: 2 });
    const fromWrongVersion = await openStore(wrongVersion, clock);
    expect(fromWrongVersion.desiredState()).toBe("disconnected");

    // Positive control: the same document unmodified loads its real state.
    const intact = tempDirectory();
    writeDocument(intact, documentWithApprovalEpoch(2));
    const fromIntact = await openStore(intact, { value: 1_000_000 });
    expect(fromIntact.desiredState()).toBe("connected");
    expect(fromIntact.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
  });

  it("re-shares under an id source that can only mint the id already in use", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    // The most hostile id source there is: every grant, pairing and scope gets
    // the same uuid. A re-share reuses the id of the grant it replaces, which
    // the document's own validator refuses as a duplicate — so this only works
    // because the replaced grant leaves on the pass that retires it.
    const store = await openStore(directory, clock, { randomUuid: () => APPROVAL_ID });
    await connectedAndApproved(store);

    clock.value += 1_000;
    expect(await store.createApproval({
      conversationId: OTHER_CONVERSATION_ID,
      conversationDigest: OTHER_CONVERSATION,
    })).not.toBeNull();

    expect(readDocument(directory).approvals).toHaveLength(1);
    expect(store.resolveActiveApproval(ACTOR, OTHER_CONVERSATION)).not.toBeNull();
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    // Non-vacuous proof that the file the store wrote passes validation: a
    // fresh store over an invalid one falls back to a disconnected document.
    const reopened = await openStore(directory, clock);
    expect(reopened.resolveActiveApproval(ACTOR, OTHER_CONVERSATION)).not.toBeNull();
  });

  it("leaves in-memory state untouched when the write fails", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const real = namespaceAt(directory);
    let failWrites = false;
    const namespace: FeatureNamespaceHandle = {
      get dir(): string {
        return real.dir;
      },
      readJson: real.readJson,
      writeJson: async <T>(name: string, value: T) => {
        if (failWrites) throw new Error("disk-full");
        await real.writeJson(name, value);
      },
      childDir: real.childDir,
    };
    const store = await openStore(directory, clock, { namespace });
    await connectedAndApproved(store);

    failWrites = true;
    await expect(store.setDisconnected()).rejects.toThrow("telegram-connection-store-invalid");
    expect(store.desiredState()).toBe("connected");
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
  });

  it("persists no bot token, telegram ids or raw pairing code, and exactly one plaintext", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const store = await openStore(directory, clock);
    await connectedAndApproved(store);
    await store.recordPollOffset(31_337);
    await store.createPendingCode({ codeDigest: CODE_DIGEST });

    const persisted = readText(directory);
    // Everything Telegram-side stays a digest. These are the values the bridge
    // actually handles at runtime, and none of them may reach the file.
    for (const secret of [
      RAW_BOT_TOKEN,
      RAW_TELEGRAM_USER_ID,
      RAW_CHAT_ID,
      RAW_PAIRING_CODE,
    ]) {
      expect(persisted).not.toContain(secret);
    }
    // The one deliberate exception, asserted rather than assumed: the host's own
    // conversation id is local, and storing it is what makes the share durable.
    expect(persisted).toContain(RAW_CONVERSATION_ID);
    expect(readDocument(directory).approvals[0]?.conversationId).toBe(RAW_CONVERSATION_ID);
    // Non-vacuous: the file really does hold this activation's state.
    expect(persisted).toContain("\"desiredState\": \"connected\"");
    expect(persisted).toContain(store.ownerSnapshot().pairing?.id ?? "unreachable");
    expect(persisted).toContain(BOT_FINGERPRINT);
  });

  it("still resolves the shared conversation after a restart", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const first = await openStore(directory, clock);
    await connectedAndApproved(first);
    expect(first.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);

    // The restart case, and the point of persisting the plaintext at all: a
    // brand-new store over the same file, with nothing carried in memory.
    const reopened = await openStore(directory, clock);
    expect(reopened.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);
    expect(reopened.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();

    // Non-vacuous: an untouched store over a fresh directory knows nothing.
    const fresh = await openStore(tempDirectory(), clock);
    expect(fresh.resolveBoundConversation(ACTOR)).toBeNull();
  });

  it("treats an approval whose conversation id was edited as no approval at all", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const original = await openStore(directory, clock);
    await connectedAndApproved(original);

    // Positive control: this exact file, unedited, is a working share.
    const intact = await openStore(directory, clock);
    expect(intact.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);
    expect(intact.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
    expect(intact.ownerSnapshot().approval).not.toBeNull();

    // Re-point the share by hand, leaving the digest it was granted under.
    const document = readDocument(directory);
    document.approvals[0]!.conversationId = OTHER_CONVERSATION_ID;
    writeDocument(directory, document);

    const tampered = await openStore(directory, clock);
    expect(tampered.resolveBoundConversation(ACTOR)).toBeNull();
    // Neither conversation resolves: the record is not an approval any more,
    // rather than an approval for one of the two conversations named in it.
    expect(tampered.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    expect(tampered.resolveActiveApproval(ACTOR, OTHER_CONVERSATION)).toBeNull();
    expect(tampered.ownerSnapshot().approval).toBeNull();
    // The pairing is untouched; only the grant died.
    expect(tampered.ownerSnapshot().pairing).not.toBeNull();
  });

  it("keeps the digest as the authorization key even when the plaintext is intact", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store);

    // Same untouched record, same conversation, wrong account.
    expect(store.resolveActiveApproval(OTHER_ACTOR, CONVERSATION)).toBeNull();
    expect(store.resolveBoundConversation(OTHER_ACTOR)).toBeNull();
    // Same account, a conversation this share was never granted for.
    expect(store.resolveActiveApproval(ACTOR, OTHER_CONVERSATION)).toBeNull();
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
  });

  it("refuses a grant whose conversation id and digest disagree", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const store = await openStore(directory, clock);
    await connectedAndApproved(store);
    const good = readText(directory);

    await expect(store.createApproval({
      conversationId: OTHER_CONVERSATION_ID,
      conversationDigest: CONVERSATION,
    })).rejects.toThrow("telegram-connection-store-input-invalid");
    expect(readText(directory)).toBe(good);
    // The share that already worked is untouched by the refused write.
    expect(store.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);
    expect(store.resolveActiveApproval(ACTOR, OTHER_CONVERSATION)).toBeNull();
  });

  it("shares one conversation at a time, so the newest grant replaces the old", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store);
    const firstId = store.ownerSnapshot().approval?.id;
    expect(store.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);

    clock.value += 1_000;
    await store.createApproval({
      conversationId: OTHER_CONVERSATION_ID,
      conversationDigest: OTHER_CONVERSATION,
    });

    expect(store.resolveBoundConversation(ACTOR)).toBe(OTHER_CONVERSATION_ID);
    expect(store.ownerSnapshot().approval?.id).not.toBe(firstId);
    expect(store.ownerSnapshot().approval?.conversationDigest).toBe(OTHER_CONVERSATION);
    // The replaced grant stops being an authority, not merely stops being shown.
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    expect(store.resolveActiveApproval(ACTOR, OTHER_CONVERSATION)).not.toBeNull();
  });

  it("keeps re-sharing working past the document's approval bound", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const store = await openStore(directory, clock);
    await connectedAndApproved(store, { ttlMs: 8 * HOUR_MS });

    // Far more re-shares than the document's bound, all inside one TTL window
    // so nothing expires on its own. A retired grant that held its slot until
    // its original expiry made this refuse partway through, and the owner was
    // told only that Telegram was unavailable.
    const shares = 40;
    for (let index = 0; index < shares; index += 1) {
      clock.value += 1_000;
      const conversationId = `sentinel-reshare-${index}`;
      expect(await store.createApproval({
        conversationId,
        conversationDigest: conversationDigestFor(BOT_FINGERPRINT, conversationId),
        ttlMs: 8 * HOUR_MS,
      })).not.toBeNull();
    }

    const newest = `sentinel-reshare-${shares - 1}`;
    expect(store.resolveBoundConversation(ACTOR)).toBe(newest);
    // One live share, and nothing else: the retired grants are gone rather
    // than filling the document with records no reader can reach.
    expect(readDocument(directory).approvals).toHaveLength(1);
    expect(readDocument(directory).approvals[0]?.conversationId).toBe(newest);
  });

  it("leaves no trace of a share the owner revoked", async () => {
    const clock = { value: 1_700_000_000_000 };
    const directory = tempDirectory();
    const store = await openStore(directory, clock);
    await connectedAndApproved(store, { ttlMs: 8 * HOUR_MS });
    // Positive control: the plaintext conversation id is on disk while shared.
    expect(readText(directory)).toContain(RAW_CONVERSATION_ID);

    expect(await store.revokeApproval(store.ownerSnapshot().approval!.id)).toBe(true);

    // The share ended hours before the grant would have expired, and the
    // conversation it named does not outlive it on disk.
    expect(readDocument(directory).approvals).toHaveLength(0);
    expect(readText(directory)).not.toContain(RAW_CONVERSATION_ID);
  });

  it("reports no bound conversation once the share or the connection ends", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store);
    expect(store.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);

    expect(await store.setPaused()).toBe(true);
    expect(store.resolveBoundConversation(ACTOR)).toBeNull();

    await store.setConnected(BOT_FINGERPRINT);
    expect(store.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);

    expect(await store.revokeApproval(store.ownerSnapshot().approval!.id)).toBe(true);
    expect(store.resolveBoundConversation(ACTOR)).toBeNull();
  });

  it("resolves an approval synchronously so an egress fence never awaits", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await connectedAndApproved(store);

    const resolved = store.resolveActiveApproval(ACTOR, CONVERSATION);
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBeInstanceOf(Promise);
    expect(typeof (resolved as unknown as { then?: unknown }).then).toBe("undefined");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved?.scope).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("notifies subscribers on every persisted change until they unsubscribe", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    let changes = 0;
    const unsubscribe = store.subscribe(() => {
      changes += 1;
    });

    await store.setConnected(BOT_FINGERPRINT);
    expect(changes).toBe(1);
    await store.recordPollOffset(10);
    expect(changes).toBe(2);
    // A no-op mutation persists nothing and must not wake the surface.
    await store.recordPollOffset(9);
    expect(changes).toBe(2);

    unsubscribe();
    await store.setDisconnected();
    expect(changes).toBe(2);
  });

  it("defaults to the telegram-bridge namespace under LVIS_HOME", async () => {
    const home = tempDirectory();
    const previous = process.env.LVIS_HOME;
    process.env.LVIS_HOME = home;
    try {
      const store = createTelegramConnectionStore({
        now: () => 1_700_000_000_000,
        conversationDigestFor,
      });
      await store.open();
      await store.setConnected(BOT_FINGERPRINT);
      const persisted = readFileSync(join(home, "telegram-bridge", FILE_NAME), "utf8");
      expect(JSON.parse(persisted)).toMatchObject({ version: 1, desiredState: "connected" });
    } finally {
      if (previous === undefined) delete process.env.LVIS_HOME;
      else process.env.LVIS_HOME = previous;
    }
  });

  it("closes the egress fence on a pairing whose actor key no longer loads", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await store.setConnected(BOT_FINGERPRINT);
    await store.reconcileActorKey(ACTOR_KEY_DIGEST);
    await connectedAndApproved(store);

    // Positive control: the same key resolves the share it granted.
    expect(await store.reconcileActorKey(ACTOR_KEY_DIGEST)).toBe(false);
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).not.toBeNull();
    expect(store.resolveBoundConversation(ACTOR)).toBe(RAW_CONVERSATION_ID);

    expect(await store.reconcileActorKey(OTHER_ACTOR_KEY_DIGEST)).toBe(true);

    // The digest is unchanged and still names the same account — it is simply
    // no longer derivable here, so nothing may resolve on it.
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();
    expect(store.resolveBoundConversation(ACTOR)).toBeNull();
    expect(store.activePairingActorDigest()).toBeNull();
    expect(store.ownerSnapshot().pairingUnrecognized).toBe(true);
  });

  it("rejects malformed digests and durations instead of storing them", async () => {
    const clock = { value: 1_700_000_000_000 };
    const store = await openStore(tempDirectory(), clock);
    await expect(store.setConnected("not-a-digest")).rejects.toThrow(
      "telegram-connection-store-input-invalid",
    );
    await expect(store.reconcileActorKey(ACTOR_KEY_DIGEST.toUpperCase()))
      .rejects.toThrow("telegram-connection-store-input-invalid");
    await expect(store.createPendingCode({ codeDigest: CODE_DIGEST.toUpperCase() }))
      .rejects.toThrow("telegram-connection-store-input-invalid");
    await expect(store.createPendingCode({ codeDigest: CODE_DIGEST, ttlMs: 30 * HOUR_MS }))
      .rejects.toThrow("telegram-connection-store-input-invalid");
    await expect(store.createApproval({
      conversationId: RAW_CONVERSATION_ID,
      conversationDigest: CONVERSATION,
      ttlMs: 0,
    }))
      .rejects.toThrow("telegram-connection-store-input-invalid");
    expect(store.desiredState()).toBe("disconnected");
    expect(store.ownerSnapshot().pendingCode).toBeNull();
  });

  it("refuses reads before open and pause before connect", async () => {
    const store = createTelegramConnectionStore({
      namespace: namespaceAt(tempDirectory()),
      now: () => 1_700_000_000_000,
      conversationDigestFor,
    });
    expect(() => store.receiptOwnerId()).toThrow("telegram-connection-store-not-open");
    expect(() => store.ownerSnapshot()).toThrow("telegram-connection-store-not-open");
    expect(store.resolveActiveApproval(ACTOR, CONVERSATION)).toBeNull();

    await store.open();
    expect(await store.setPaused()).toBe(false);
    expect(store.desiredState()).toBe("disconnected");
  });
});
