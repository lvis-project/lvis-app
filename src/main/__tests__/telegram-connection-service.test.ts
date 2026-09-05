import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretEncryptionUnavailableError } from "../../data/secret-document-store.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import {
  isTelegramPairingCode,
  parseTelegramConnectionSnapshot,
  type TelegramConnectionSnapshot,
} from "../../shared/telegram-connection.js";
import type {
  TelegramBotApiClient,
  TelegramBotApiFailureReason,
} from "../telegram-bot-api-client.js";
import {
  createTelegramConnectionService,
  type TelegramConnectionService,
} from "../telegram-connection-service.js";
import {
  createTelegramConnectionStore,
  type TelegramConnectionStore,
} from "../telegram-connection-store.js";
import { mintTelegramPairingCode, telegramPairingCodeDigest } from "../telegram-pairing-code.js";
import { conversationDigestFor, namespaceAt } from "./telegram-connection-namespace.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

/** The service must mint codes the ingress-side authority can redeem. */
function redeemableDigest(code: string): string {
  const digest = telegramPairingCodeDigest(code);
  expect(digest).not.toBeNull();
  return digest!;
}

/** Raw values the owner surface handles; none may reach a snapshot. */
const BOT_TOKEN = "123456789:SENTINEL-bot-token-must-not-persist";
const OTHER_BOT_TOKEN = "987654321:SENTINEL-second-bot-token-value";
const RAW_CHAT_ID = "-1009988776655";
const RAW_TELEGRAM_USER_ID = "776655443322";
const CONVERSATION_ID = "sentinel-conversation-id-9f2c";
const OTHER_CONVERSATION_ID = "sentinel-other-conversation-id-4b71";
const BOT_USERNAME = "lvis_owner_bot";
const SECRET_KEY = "telegram.botToken.v1";

const ACTOR_DIGEST = createHash("sha256").update("actor", "utf8")
  .update(RAW_TELEGRAM_USER_ID, "utf8").digest("hex");
/** Stands in for the platform runtime's digest of this machine's actor key. */
const ACTOR_KEY_DIGEST = createHash("sha256").update("actor-key", "utf8")
  .update("the-key-this-machine-can-load", "utf8").digest("hex");

let directories: string[] = [];

afterEach(async () => {
  for (const directory of directories) await cleanupTmpDir(directory);
  directories = [];
});


/** Records every store call so "never touches the store" is checkable. */
function trackedStore(real: TelegramConnectionStore): {
  readonly store: TelegramConnectionStore;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const source = real as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrapped = Object.fromEntries(Object.keys(source).map((name) => [
    name,
    (...args: unknown[]) => {
      calls.push(name);
      return source[name]!(...args);
    },
  ]));
  return { store: wrapped as unknown as TelegramConnectionStore, calls };
}

function secretsFixture(encrypted = true) {
  const values = new Map<string, string>();
  const state = { encrypted };
  return {
    values,
    state,
    service: {
      setSecret: vi.fn(async (key: string, value: string) => {
        if (!state.encrypted) throw new SecretEncryptionUnavailableError();
        values.set(key, value);
      }),
      getEncryptedSecret: vi.fn((key: string) => values.get(key) ?? null),
      deleteSecret: vi.fn(async (key: string) => {
        values.delete(key);
      }),
      isSecretStorageEncrypted: vi.fn(() => state.encrypted),
    },
  };
}

function botApiFixture() {
  const state = {
    getMe: { ok: true, value: { username: BOT_USERNAME } } as unknown,
    webhook: { ok: true, value: { hasWebhook: false } } as unknown,
    throwOnGetMe: false,
  };
  const client: TelegramBotApiClient = {
    getMe: vi.fn(async () => {
      if (state.throwOnGetMe) throw new Error(`fetch failed https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
      return state.getMe;
    }) as unknown as TelegramBotApiClient["getMe"],
    getWebhookInfo: vi.fn(async () => state.webhook) as unknown as TelegramBotApiClient["getWebhookInfo"],
    getUpdates: vi.fn(async () => ({ ok: true as const, value: [] })),
    // The owner service never sends; a call here would be a regression.
    sendMessage: vi.fn(async () => ({ ok: true as const, value: true as const })),
    sendDecisionCard: vi.fn(async () => ({ ok: true as const, value: { messageId: 1 } })),
    editMessageText: vi.fn(async () => ({ ok: true as const, value: true as const })),
    answerCallbackQuery: vi.fn(async () => ({ ok: true as const, value: true as const })),
  };
  const created: string[] = [];
  return {
    state,
    client,
    created,
    factory: (botToken: string): TelegramBotApiClient => {
      created.push(botToken);
      return client;
    },
    rejectWith(reason: TelegramBotApiFailureReason): void {
      state.getMe = { ok: false, reason };
    },
  };
}

interface Harness {
  readonly service: TelegramConnectionService;
  readonly store: TelegramConnectionStore;
  /** Where the store's real `connection.json` lands, for on-disk assertions. */
  readonly directory: string;
  readonly calls: string[];
  readonly secrets: ReturnType<typeof secretsFixture>;
  readonly bot: ReturnType<typeof botApiFixture>;
  readonly bridge: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  /**
   * The composed reconcile, as a spy over the real store call. `digest` is the
   * name of the key this machine can load right now, so a test rotates the key
   * by changing it — the same evidence the platform runtime would hand over.
   */
  readonly reconcileActorKey: ReturnType<typeof vi.fn>;
  readonly reconcile: { digest: string; fail: boolean };
  readonly conversation: { id: string };
  /**
   * The conversations that exist, as the app's own list would report them.
   * A test deletes one by removing its id, which is what makes the share
   * dangle without touching the store the share lives in.
   */
  readonly existingConversations: Set<string>;
  /** The store's own bot identity, so a test can name a digest the way it does. */
  digestOf(conversationId: string): string;
}

async function harness(
  options: {
    readonly encrypted?: boolean;
    readonly existingConversations?: readonly string[];
  } = {},
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "lvis-telegram-service-"));
  directories.push(directory);
  const real = createTelegramConnectionStore({
    namespace: namespaceAt(directory),
    conversationDigestFor,
  });
  await real.open();
  // Mirrors main composition: the service resolves the bot from the store, so
  // before a bot is verified there is no digest and no approval is possible.
  const digestOf = (conversationId: string): string => {
    const botFingerprint = real.botFingerprint();
    if (botFingerprint === null) throw new Error("telegram-conversation-digest-unavailable");
    return conversationDigestFor(botFingerprint, conversationId);
  };
  const tracked = trackedStore(real);
  const secrets = secretsFixture(options.encrypted ?? true);
  const bot = botApiFixture();
  const bridge = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  // Mirrors main composition: the reconcile names this machine's actor key to
  // the store, and the store alone decides what a changed name costs.
  const reconcile = { digest: ACTOR_KEY_DIGEST, fail: false };
  const reconcileActorKey = vi.fn(async () => {
    if (reconcile.fail) throw new Error("this machine could not name its actor key");
    await real.reconcileActorKey(reconcile.digest);
  });
  const conversation = { id: CONVERSATION_ID };
  // Both by default: a test that shares the other conversation is exercising a
  // reshare, not a deletion, and would otherwise dangle for the wrong reason.
  const existingConversations = new Set(
    options.existingConversations ?? [CONVERSATION_ID, OTHER_CONVERSATION_ID],
  );
  const service = createTelegramConnectionService({
    store: tracked.store,
    settingsService: secrets.service,
    bridgeControl: bridge,
    reconcileActorKey,
    getCurrentConversationId: () => conversation.id,
    conversationDigestFor: digestOf,
    conversationExists: (conversationId: string) => existingConversations.has(conversationId),
    // The suite injects its own client factory, so no request may reach a
    // transport; this one fails loudly if that ever changes.
    networkFetch: unusedNetworkFetch,
    createBotApiClient: bot.factory,
  });
  return {
    service, store: real, directory, calls: tracked.calls,
    secrets, bot, bridge, reconcileActorKey, reconcile,
    conversation, existingConversations, digestOf,
  };
}

function snapshotOf(service: TelegramConnectionService): TelegramConnectionSnapshot {
  const result = service.snapshot();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.snapshot;
}

/** connect → mint → redeem, i.e. an identified account with no access yet. */
async function pairedHarness(): Promise<Harness & { readonly code: string }> {
  const h = await harness();
  expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
  const minted = await h.service.createPairingCode();
  expect(minted.ok).toBe(true);
  if (!minted.ok) throw new Error("unreachable");
  const paired = await h.store.completePairing({
    codeDigest: redeemableDigest(minted.pairingCode.code),
    actorDigest: ACTOR_DIGEST,
  });
  expect(paired).not.toBeNull();
  return { ...h, code: minted.pairingCode.code };
}

describe("createTelegramConnectionService", () => {
  it("reports unsupported and writes no secret when storage is not encrypted", async () => {
    const h = await harness({ encrypted: false });

    expect(snapshotOf(h.service).state).toBe("unsupported");
    expect(await h.service.connect(BOT_TOKEN)).toEqual({
      ok: false,
      error: "telegram-encryption-unavailable",
    });
    expect(h.secrets.service.setSecret).not.toHaveBeenCalled();
    expect(h.secrets.values.size).toBe(0);
    expect(h.calls).not.toContain("setConnected");
    expect(h.calls).not.toContain("setLastError");
    expect(h.bot.created).toEqual([]);

    // Positive control: the identical path succeeds once storage can encrypt.
    h.secrets.state.encrypted = true;
    expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    expect(h.secrets.values.get(SECRET_KEY)).toBe(BOT_TOKEN);
  });

  it("rolls the secret back when getMe rejects the token", async () => {
    const h = await harness();
    h.bot.rejectWith("unauthorized");

    expect(await h.service.connect(BOT_TOKEN)).toEqual({
      ok: false,
      error: "telegram-bot-token-rejected",
    });
    expect(h.secrets.values.size).toBe(0);
    expect(h.store.desiredState()).toBe("disconnected");
    expect(h.bridge.start).not.toHaveBeenCalled();
    expect(snapshotOf(h.service).lastErrorCode).toBe("telegram-bot-token-rejected");
  });

  it("restores the previous token when a replacement is rejected", async () => {
    const h = await harness();
    expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    h.bot.rejectWith("unauthorized");

    expect(await h.service.connect(OTHER_BOT_TOKEN)).toEqual({
      ok: false,
      error: "telegram-bot-token-rejected",
    });
    // A failed replacement must not destroy the credential that still works.
    expect(h.secrets.values.get(SECRET_KEY)).toBe(BOT_TOKEN);
  });

  it("fails closed when the bot already has a webhook", async () => {
    const h = await harness();
    h.bot.state.webhook = { ok: true, value: { hasWebhook: true } };

    expect(await h.service.connect(BOT_TOKEN)).toEqual({
      ok: false,
      error: "telegram-webhook-conflict",
    });
    expect(h.secrets.values.size).toBe(0);
    expect(h.store.desiredState()).toBe("disconnected");
    expect(h.bridge.start).not.toHaveBeenCalled();
    // Locked inventory: the client exposes no webhook mutator at all, so none
    // can be called. `sendMessage` is a host-authored control notice, not a
    // bot-configuration call; adding anything here must be deliberate.
    // The three decision-card methods are the remote-approval surface: fixed
    // host text and opaque tokens outbound, one acknowledgement inbound —
    // still nothing that can reconfigure the owner's bot.
    expect(Object.keys(h.bot.client)).toEqual([
      "getMe",
      "getWebhookInfo",
      "getUpdates",
      "sendMessage",
      "sendDecisionCard",
      "editMessageText",
      "answerCallbackQuery",
    ]);
    // The owner service itself never sends — only the ingress does.
    expect(h.bot.client.sendMessage).not.toHaveBeenCalled();
  });

  it("maps provider failures to stable codes and never echoes the token", async () => {
    const conflict = await harness();
    conflict.bot.rejectWith("conflict");
    expect(await conflict.service.connect(BOT_TOKEN)).toEqual({
      ok: false,
      error: "telegram-poll-conflict",
    });

    const limited = await harness();
    limited.bot.rejectWith("rate-limited");
    expect(await limited.service.connect(BOT_TOKEN)).toEqual({
      ok: false,
      error: "telegram-provider-unreachable",
    });

    const thrown = await harness();
    thrown.bot.state.throwOnGetMe = true;
    const result = await thrown.service.connect(BOT_TOKEN);
    expect(result).toEqual({ ok: false, error: "telegram-provider-unreachable" });
    // The thrown fetch error carries the token in its URL; it must not survive.
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });

  it("rejects a malformed token before contacting the provider", async () => {
    const h = await harness();
    expect(await h.service.connect("not-a-bot-token")).toEqual({
      ok: false,
      error: "telegram-connection-input-invalid",
    });
    expect(h.bot.created).toEqual([]);
    expect(h.secrets.service.setSecret).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("setConnected");
  });

  it("treats pairing as identification only, never as access", async () => {
    const h = await harness();
    expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("connected-unpaired");

    const minted = await h.service.createPairingCode();
    expect(minted.ok).toBe(true);
    expect(snapshotOf(h.service).state).toBe("pairing-pending");
    if (!minted.ok) throw new Error("unreachable");

    expect(await h.store.completePairing({
      codeDigest: redeemableDigest(minted.pairingCode.code),
      actorDigest: ACTOR_DIGEST,
    })).not.toBeNull();

    const snapshot = snapshotOf(h.service);
    expect(snapshot.state).toBe("paired-unapproved");
    expect(snapshot.pairing?.accountFingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(snapshot.approval).toBeNull();
    // A paired account sending a normal message resolves no authority.
    expect(h.store.resolveActiveApproval(
      ACTOR_DIGEST,
      h.digestOf(CONVERSATION_ID),
    )).toBeNull();
    expect(h.store.resolveBoundConversation(ACTOR_DIGEST)).toBeNull();
  });

  it("reports a rotated actor key as its own state, not as paired and not as an error", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });

    // Positive control: while the key still names the account, the surface
    // says so — this is the reading the guard has to replace, not weaken.
    const paired = snapshotOf(h.service);
    expect(paired.state).toBe("active");
    expect(paired.pairing?.accountFingerprint).toMatch(/^[a-f0-9]{12}$/);

    // The activation guard, with a key this machine can no longer produce.
    expect(await h.store.reconcileActorKey("f".repeat(64))).toBe(true);

    const lost = snapshotOf(h.service);
    expect(lost.state).toBe("pairing-unrecognized");
    expect(lost.pairing).toBeNull();
    expect(lost.approval).toBeNull();
    // Nothing was recorded as a connection failure: the bot is fine, and an
    // error code here would be answered as `error`, which withholds the
    // pairing affordance the owner needs. The test below pins that ordering.
    expect(lost.lastErrorCode).toBeNull();
  });

  it("reconciles the actor key before it reads the credential a resume needs", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });

    // One keychain reset takes both secrets: the stored bot token is gone, and
    // so is the key every stored actor digest was minted under.
    h.secrets.values.delete(SECRET_KEY);
    h.reconcile.digest = "f".repeat(64);
    h.reconcileActorKey.mockClear();
    h.secrets.service.getEncryptedSecret.mockClear();
    h.bridge.start.mockClear();

    await h.service.resumeStoredConnection();

    // The resume gives up at the missing credential and never starts a bridge,
    // so everything downstream of that return is unreachable — which is why
    // the reconcile has to come before the read and not with the activation.
    expect(h.bridge.start).not.toHaveBeenCalled();
    expect(h.reconcileActorKey).toHaveBeenCalledTimes(1);
    expect(h.secrets.service.getEncryptedSecret).toHaveBeenCalled();
    expect(h.reconcileActorKey.mock.invocationCallOrder[0]!)
      .toBeLessThan(h.secrets.service.getEncryptedSecret.mock.invocationCallOrder[0]!);

    const lost = snapshotOf(h.service);
    expect(lost.pairing).toBeNull();
    // The lost token is still reported as itself; the reconcile does not
    // swallow the failure that exposed it.
    expect(lost.lastErrorCode).toBe("telegram-bot-token-unreadable");
  });

  it("names this machine's actor key on connect, so a later resume reads continuity", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });

    // Nothing changed between the two: the same key still loads. A resume has
    // to read that as continuity rather than as a rotation, which it can only
    // do if the connect that preceded the pairing named the key to the store.
    await h.service.resumeStoredConnection();

    const still = snapshotOf(h.service);
    expect(still.state).toBe("active");
    expect(still.pairing).not.toBeNull();
    expect(still.approval).not.toBeNull();
  });

  it("refuses to resume when the actor key cannot be named at all", async () => {
    const h = await pairedHarness();
    h.reconcile.fail = true;
    h.bridge.start.mockClear();

    expect(await h.service.resume()).toEqual({ ok: false, error: "telegram-connection-unavailable" });
    // Unnameable is not the same as rotated: nothing was retired, and nothing
    // was started either. A bridge whose pairing cannot be checked must not run.
    expect(h.bridge.start).not.toHaveBeenCalled();
    expect(snapshotOf(h.service).lastErrorCode).toBe("telegram-connection-unavailable");
  });

  it("answers a recorded error before any pairing state, whatever the pairing is", async () => {
    const h = await pairedHarness();
    expect(await h.store.reconcileActorKey("f".repeat(64))).toBe(true);
    expect(snapshotOf(h.service).state).toBe("pairing-unrecognized");

    await h.store.setLastError("telegram-poll-conflict");

    expect(snapshotOf(h.service).state).toBe("error");
  });

  it("keeps the share active when the owner looks at another conversation", async () => {
    const h = await pairedHarness();

    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });
    const approved = snapshotOf(h.service);
    expect(approved.state).toBe("active");
    expect(approved.approval?.matchesCurrentConversation).toBe(true);
    expect(h.store.resolveActiveApproval(
      ACTOR_DIGEST,
      h.digestOf(CONVERSATION_ID),
    )).not.toBeNull();

    h.conversation.id = OTHER_CONVERSATION_ID;
    const switched = snapshotOf(h.service);
    // The share is durable: looking elsewhere is a property of the approval,
    // not a state the connection falls into and has to be repaired from.
    expect(switched.state).toBe("active");
    expect(switched.approval?.matchesCurrentConversation).toBe(false);
    expect(switched.approval?.id).toBe(approved.approval?.id);
    // And it is still bound to the conversation that was actually shared.
    expect(h.store.resolveBoundConversation(ACTOR_DIGEST)).toBe(CONVERSATION_ID);
  });

  it("does not call a conversation deleted just because it has never been saved", async () => {
    const h = await pairedHarness();
    // A conversation the owner just opened: on screen, routable, but with no
    // transcript file until its first turn is written.
    h.existingConversations.delete(CONVERSATION_ID);

    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });

    // This used to report `shared-conversation-missing` the instant the owner
    // shared it — beside a success toast — and on every refresh until they
    // said something. The share was routing correctly the entire time.
    expect(snapshotOf(h.service).state).toBe("active");
  });

  it("still reports a deleted conversation once the owner looks elsewhere", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });

    // Non-vacuous: the exemption above is scoped to the conversation on screen,
    // so a share that is genuinely gone must still be reported. Without this,
    // the fix could have been "never report missing".
    h.existingConversations.delete(CONVERSATION_ID);
    h.conversation.id = OTHER_CONVERSATION_ID;

    expect(snapshotOf(h.service).state).toBe("shared-conversation-missing");
  });

  it("says the shared conversation is gone instead of calling it merely closed", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });
    // Positive control: the same snapshot reads `active` while the conversation
    // is there, so the assertion below is about the deletion and nothing else.
    const live = snapshotOf(h.service);
    expect(live.state).toBe("active");
    expect(live.approval?.id).toBeDefined();

    // Deleted from the app, not from the connection store: the share is still a
    // live grant, which is precisely why it can dangle. The owner is looking
    // elsewhere, because a conversation cannot be both deleted and on screen —
    // the resolver treats the current conversation as existing whether or not
    // it has a transcript yet.
    h.conversation.id = OTHER_CONVERSATION_ID;
    h.existingConversations.delete(CONVERSATION_ID);

    const dangling = snapshotOf(h.service);
    expect(dangling.state).toBe("shared-conversation-missing");
    // The grant itself is untouched — this is a report, not a revocation. An
    // owner who restores a backup gets their share back.
    expect(dangling.approval?.id).toBe(live.approval?.id);
    expect(h.store.resolveBoundConversation(ACTOR_DIGEST)).toBe(CONVERSATION_ID);
  });

  it("does not confuse a deleted share with one the owner navigated away from", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });

    // Looking elsewhere: the conversation still exists, so the share stays
    // active and only the approval reports the mismatch.
    h.conversation.id = OTHER_CONVERSATION_ID;
    const elsewhere = snapshotOf(h.service);
    expect(elsewhere.state).toBe("active");
    expect(elsewhere.approval?.matchesCurrentConversation).toBe(false);

    // Same "not on screen" reading, different cause. Before the resolver told
    // these apart, both produced the state above and the surface told the owner
    // to reopen a conversation that no longer existed.
    h.existingConversations.delete(CONVERSATION_ID);
    const deleted = snapshotOf(h.service);
    expect(deleted.state).toBe("shared-conversation-missing");
    expect(deleted.approval?.matchesCurrentConversation).toBe(false);
  });

  it("treats an unanswerable existence check as missing rather than healthy", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("active");

    // A Set whose lookup throws stands in for a conversation store that cannot
    // answer. "I could not check" is not evidence the conversation is there,
    // and defaulting to healthy would hide the loss it was asked about.
    // Off the shared conversation first: the current-conversation shortcut
    // answers before the existence check, so the throwing path is only
    // reachable for a share the owner is not looking at.
    h.conversation.id = OTHER_CONVERSATION_ID;
    const broken = h.existingConversations as unknown as { has: () => boolean };
    const original = broken.has;
    broken.has = () => {
      throw new Error("conversation index unavailable");
    };
    try {
      expect(snapshotOf(h.service).state).toBe("shared-conversation-missing");
    } finally {
      broken.has = original;
    }
    // And it recovers: the state is derived per snapshot, never latched.
    expect(snapshotOf(h.service).state).toBe("active");
  });

  it("shares the conversation on screen, replacing the previous share", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });
    const first = snapshotOf(h.service).approval?.id;

    h.conversation.id = OTHER_CONVERSATION_ID;
    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });

    const reshared = snapshotOf(h.service);
    expect(reshared.state).toBe("active");
    expect(reshared.approval?.matchesCurrentConversation).toBe(true);
    expect(reshared.approval?.id).not.toBe(first);
    expect(h.store.resolveBoundConversation(ACTOR_DIGEST)).toBe(OTHER_CONVERSATION_ID);
    // The replaced grant is gone, not merely hidden behind the newer one.
    expect(h.store.resolveActiveApproval(
      ACTOR_DIGEST,
      h.digestOf(CONVERSATION_ID),
    )).toBeNull();
  });

  it("cannot report a conversation-inactive state the contract no longer has", () => {
    const base = {
      botUsername: null,
      pairing: null,
      approval: null,
      pendingCode: null,
      lastErrorCode: null,
    };
    // Retired with the durable binding: a producer that still emitted it would
    // be rejected by the shared parser rather than reach a renderer.
    expect(parseTelegramConnectionSnapshot({ ...base, state: "paused-conversation-inactive" }))
      .toBeNull();
    // Non-vacuous: the state that absorbed it parses through the same call.
    expect(parseTelegramConnectionSnapshot({ ...base, state: "active" })).not.toBeNull();
  });

  it("never reports active while the owner has paused", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation()).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("active");

    expect(await h.service.pause()).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("paused-by-owner");
    expect(h.bridge.stop).toHaveBeenCalledWith("user");

    expect(await h.service.resume()).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("active");
  });

  it("returns the raw pairing code once and never again", async () => {
    const h = await harness();
    expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    const minted = await h.service.createPairingCode();
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error("unreachable");

    expect(isTelegramPairingCode(minted.pairingCode.code)).toBe(true);
    expect(minted.pairingCode.botUsername).toBe(BOT_USERNAME);
    expect(JSON.stringify(snapshotOf(h.service))).not.toContain(minted.pairingCode.code);

    await h.store.completePairing({
      codeDigest: redeemableDigest(minted.pairingCode.code),
      actorDigest: ACTOR_DIGEST,
    });
    expect(JSON.stringify(snapshotOf(h.service))).not.toContain(minted.pairingCode.code);
  });

  it("persists exactly the digest the redemption path will recompute", async () => {
    const h = await harness();
    expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    const minted = await h.service.createPairingCode();
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error("unreachable");

    // The seam: the ingress redeems by calling telegramPairingCodeDigest on the
    // pasted text, so the byte the store holds must be exactly that digest. A
    // local digest reintroduced on either side changes one of these two values.
    const persisted = JSON.parse(readFileSync(join(h.directory, "connection.json"), "utf8")) as {
      pendingCode: { codeDigest: string } | null;
    };
    expect(persisted.pendingCode).not.toBeNull();
    expect(persisted.pendingCode?.codeDigest)
      .toBe(telegramPairingCodeDigest(minted.pairingCode.code));
    // Non-vacuous: the digest is not the code, and not a digest of some other code.
    expect(persisted.pendingCode?.codeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.pendingCode?.codeDigest)
      .not.toBe(telegramPairingCodeDigest(mintTelegramPairingCode()));
  });

  it("refuses to mint a pairing code before this activation verified a bot", async () => {
    const h = await harness();
    expect(await h.service.createPairingCode()).toEqual({
      ok: false,
      error: "telegram-connection-unavailable",
    });
    expect(h.calls).not.toContain("createPendingCode");
  });

  it("projects a snapshot the shared parser accepts and no sentinel value", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation("24h")).toEqual({ ok: true });

    const snapshot = snapshotOf(h.service);
    expect(parseTelegramConnectionSnapshot(snapshot)).not.toBeNull();
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      BOT_TOKEN,
      RAW_CHAT_ID,
      RAW_TELEGRAM_USER_ID,
      CONVERSATION_ID,
      h.code,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // Non-vacuous: the projection really is reporting this live connection.
    expect(serialized).toContain("active");
    expect(snapshot.botUsername).toBe(BOT_USERNAME);
  });

  it("disconnects as a user action, clearing the secret and the store", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation()).toEqual({ ok: true });

    expect(await h.service.disconnect()).toEqual({ ok: true });
    expect(h.secrets.values.size).toBe(0);
    expect(h.store.desiredState()).toBe("disconnected");
    expect(h.store.ownerSnapshot().pairing).toBeNull();
    expect(h.bridge.stop).toHaveBeenCalledWith("user");
    expect(h.bridge.stop).not.toHaveBeenCalledWith("shutdown");

    const snapshot = snapshotOf(h.service);
    expect(snapshot.state).toBe("disconnected");
    expect(snapshot.botUsername).toBeNull();
  });

  it("cannot resume once the credential is gone", async () => {
    const h = await pairedHarness();
    expect(await h.service.disconnect()).toEqual({ ok: true });
    expect(await h.service.resume()).toEqual({
      ok: false,
      error: "telegram-bot-token-unreadable",
    });
    expect(h.bridge.start).toHaveBeenCalledTimes(1);
  });

  it("reports an unreadable token instead of a live share nothing is behind", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation()).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("active");
    // A keychain reset or a restore onto another machine: storage still reports
    // itself encrypted, and the value it held no longer comes back.
    h.secrets.values.delete(SECRET_KEY);
    h.bridge.start.mockClear();

    await h.service.resumeStoredConnection();

    const snapshot = snapshotOf(h.service);
    // `active` here is the whole defect: it is what the settings screen reads to
    // claim a live share, and what enables the Away Authority arm control, while
    // no poll loop exists.
    expect(snapshot.state).toBe("error");
    expect(snapshot.lastErrorCode).toBe("telegram-bot-token-unreadable");
    expect(h.bridge.start).not.toHaveBeenCalled();
    // Only the credential is gone; the pairing and the share are still the
    // owner's, and re-entering the same token adopts them again.
    expect(snapshot.pairing).not.toBeNull();
    expect(snapshot.approval).not.toBeNull();

    // Non-vacuous: the identical boot continuation resumes to a live share the
    // moment the credential reads back.
    h.secrets.values.set(SECRET_KEY, BOT_TOKEN);
    await h.service.resumeStoredConnection();
    expect(snapshotOf(h.service).state).toBe("active");
    expect(snapshotOf(h.service).lastErrorCode).toBeNull();
  });

  it("keeps the pairing when the bridge fails to start on a boot resume", async () => {
    const h = await pairedHarness();
    expect(await h.service.approveCurrentConversation()).toEqual({ ok: true });
    await h.store.recordPollOffset(4_242);
    const pairingId = snapshotOf(h.service).pairing?.id;
    // A Windows EPERM/EBUSY, a locked feature namespace, an unreadable actor
    // key: transient, unattended, and none of it the owner's doing.
    h.bridge.start.mockRejectedValueOnce(new Error("EPERM"));

    await h.service.resumeStoredConnection();

    const snapshot = snapshotOf(h.service);
    // Not `disconnected`. That state was produced by a reset which is not the
    // inverse of connecting: it erases the pairing, every approval, the pending
    // code and the poll offset, none of which the failure touched.
    expect(snapshot.state).toBe("error");
    expect(snapshot.lastErrorCode).toBe("telegram-connection-unavailable");
    expect(snapshot.pairing?.id).toBe(pairingId);
    expect(snapshot.approval).not.toBeNull();
    expect(h.store.desiredState()).toBe("connected");
    expect(h.store.activePairingActorDigest()).toBe(ACTOR_DIGEST);
    expect(h.store.pollOffset()).toBe(4_242);

    // And the state says so rather than merely preserving things quietly: the
    // recorded error is what the surface renders, and the retry it offers is
    // this same resume, which clears the error once the condition passes.
    expect(await h.service.resume()).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("active");
    expect(snapshotOf(h.service).lastErrorCode).toBeNull();
  });

  it("rolls a failed first connect back to the state it started from", async () => {
    const h = await harness();
    h.bridge.start.mockRejectedValueOnce(new Error("EPERM"));

    expect(await h.service.connect(BOT_TOKEN)).toEqual({
      ok: false,
      error: "telegram-connection-unavailable",
    });
    // Symmetric with the credential rollback, and safe for the same reason: a
    // store that was `disconnected` holds no pairing and no approval, so putting
    // it back destroys nothing and leaves the Connect control on screen.
    expect(h.secrets.values.size).toBe(0);
    expect(h.store.desiredState()).toBe("disconnected");
    const snapshot = snapshotOf(h.service);
    expect(snapshot.state).toBe("disconnected");
    expect(snapshot.lastErrorCode).toBe("telegram-connection-unavailable");

    // Non-vacuous: the same call connects once the bridge starts.
    expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    expect(snapshotOf(h.service).state).toBe("connected-unpaired");
  });

  it("rejects pause when nothing is connected", async () => {
    const h = await harness();
    expect(await h.service.pause()).toEqual({
      ok: false,
      error: "telegram-connection-operation-rejected",
    });
    expect(h.bridge.stop).not.toHaveBeenCalled();
  });

  it("notifies subscribers on store changes and when the bot handle resolves", async () => {
    const h = await harness();
    let changes = 0;
    const unsubscribe = h.service.subscribe(() => {
      changes += 1;
    });

    expect(await h.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    expect(changes).toBeGreaterThan(0);
    const afterConnect = changes;
    await h.service.createPairingCode();
    expect(changes).toBeGreaterThan(afterConnect);

    unsubscribe();
    const settled = changes;
    await h.service.disconnect();
    expect(changes).toBe(settled);
  });
});
