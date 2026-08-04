import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretEncryptionUnavailableError } from "../../data/secret-document-store.js";
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
import { namespaceAt } from "./telegram-connection-namespace.js";

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

let directories: string[] = [];

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});


function conversationDigestFor(conversationId: string): string {
  return createHash("sha256").update("conversation", "utf8").update("\0", "utf8")
    .update(conversationId, "utf8").digest("hex");
}

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
  readonly conversation: { id: string };
}

async function harness(
  options: { readonly envManaged?: boolean; readonly encrypted?: boolean } = {},
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "lvis-telegram-service-"));
  directories.push(directory);
  const real = createTelegramConnectionStore({ namespace: namespaceAt(directory) });
  await real.open();
  const tracked = trackedStore(real);
  const secrets = secretsFixture(options.encrypted ?? true);
  const bot = botApiFixture();
  const bridge = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const conversation = { id: CONVERSATION_ID };
  const service = createTelegramConnectionService({
    store: tracked.store,
    settingsService: secrets.service,
    bridgeControl: bridge,
    getCurrentConversationId: () => conversation.id,
    conversationDigestFor,
    envManaged: options.envManaged ?? false,
    createBotApiClient: bot.factory,
  });
  return { service, store: real, directory, calls: tracked.calls, secrets, bot, bridge, conversation };
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
  it("locks every mutation to the environment without reading the store", async () => {
    const h = await harness({ envManaged: true });
    const managed = { ok: false, error: "telegram-managed-by-environment" };

    expect(snapshotOf(h.service)).toEqual({
      state: "env-managed",
      botUsername: null,
      pairing: null,
      approval: null,
      pendingCode: null,
      lastErrorCode: null,
    });
    expect(await h.service.connect(BOT_TOKEN)).toEqual(managed);
    expect(await h.service.disconnect()).toEqual(managed);
    expect(await h.service.pause()).toEqual(managed);
    expect(await h.service.resume()).toEqual(managed);
    expect(await h.service.createPairingCode()).toEqual(managed);
    expect(await h.service.revokePairing("11111111-1111-4111-8111-111111111111")).toEqual(managed);
    expect(await h.service.approveCurrentConversation()).toEqual(managed);
    expect(await h.service.revokeApproval("11111111-1111-4111-8111-111111111111")).toEqual(managed);

    expect(h.calls).toEqual([]);
    expect(h.secrets.service.setSecret).not.toHaveBeenCalled();
    expect(h.secrets.service.isSecretStorageEncrypted).not.toHaveBeenCalled();
    expect(h.bridge.start).not.toHaveBeenCalled();
    expect(h.bot.created).toEqual([]);

    // Positive control: the same wiring without the env var does connect.
    const open = await harness({ envManaged: false });
    expect(await open.service.connect(BOT_TOKEN)).toEqual({ ok: true });
    expect(open.calls).toContain("setConnected");
  });

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
    expect(Object.keys(h.bot.client)).toEqual([
      "getMe",
      "getWebhookInfo",
      "getUpdates",
      "sendMessage",
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
      conversationDigestFor(CONVERSATION_ID),
    )).toBeNull();
  });

  it("derives active only for the conversation on screen", async () => {
    const h = await pairedHarness();

    expect(await h.service.approveCurrentConversation("1h")).toEqual({ ok: true });
    const approved = snapshotOf(h.service);
    expect(approved.state).toBe("active");
    expect(approved.approval?.matchesCurrentConversation).toBe(true);
    expect(h.store.resolveActiveApproval(
      ACTOR_DIGEST,
      conversationDigestFor(CONVERSATION_ID),
    )).not.toBeNull();

    h.conversation.id = OTHER_CONVERSATION_ID;
    const switched = snapshotOf(h.service);
    expect(switched.state).toBe("paused-conversation-inactive");
    expect(switched.approval?.matchesCurrentConversation).toBe(false);
    expect(switched.approval?.id).toBe(approved.approval?.id);
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
      error: "telegram-connection-unavailable",
    });
    expect(h.bridge.start).toHaveBeenCalledTimes(1);
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
