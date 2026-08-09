import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemorySecretStore,
  SafeStorageSecretStore,
  type SafeStorageLike,
  type SecretStore,
} from "../../audit/hmac-chain.js";
import type {
  PlatformBridgeInboundAuthorization,
  PlatformBridgeVerifiedEnvelope,
} from "../platform-bridge-inbound.js";
import {
  createTelegramActorDigester,
  createTelegramPlatformRuntime,
  ensureTelegramPlatformActorSecret,
  TELEGRAM_PLATFORM_ACTOR_SECRET_NAME,
  type CreateTelegramPlatformRuntimeOptions,
} from "../telegram-platform-runtime.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const OWNER_ID = "123456789";
const OTHER_OWNER_ID = "987654321";
const BOT_FINGERPRINT = "a".repeat(64);
const SECOND_BOT_FINGERPRINT = "b".repeat(64);
const CONVERSATION_ID = "conversation-owner-private";

function envelope(
  overrides: Partial<PlatformBridgeVerifiedEnvelope> = {},
): PlatformBridgeVerifiedEnvelope {
  return {
    provider: "telegram",
    deliveryId: "telegram-update-123",
    channelId: OWNER_ID,
    senderId: OWNER_ID,
    text: "private Telegram message",
    ...overrides,
  };
}

function createRuntime(
  overrides: Partial<CreateTelegramPlatformRuntimeOptions> = {},
) {
  const current = { value: CONVERSATION_ID, epoch: 0 };
  const runtime = createTelegramPlatformRuntime({
    allowedUserIds: [OWNER_ID],
    botFingerprint: BOT_FINGERPRINT,
    getCurrentConversationId: () => current.value,
    getCurrentConversationEpoch: () => current.epoch,
    secretStore: new MemorySecretStore(),
    activationEpoch: 1,
    ...overrides,
  });
  return { runtime, current };
}

async function authorize(
  runtime: ReturnType<typeof createTelegramPlatformRuntime>,
  candidate: PlatformBridgeVerifiedEnvelope,
): Promise<PlatformBridgeInboundAuthorization | null> {
  return await runtime.authorize(candidate) ?? null;
}

describe("TelegramPlatformRuntime", () => {
  it("creates fixed private-DM routes with opaque actor and deterministic UUIDv8 bindings", async () => {
    let reads = 0;
    const current = { value: CONVERSATION_ID, epoch: 0 };
    const runtime = createTelegramPlatformRuntime({
      allowedUserIds: [OWNER_ID, OTHER_OWNER_ID],
      botFingerprint: BOT_FINGERPRINT,
      getCurrentConversationId: () => {
        reads += 1;
        return current.value;
      },
      getCurrentConversationEpoch: () => current.epoch,
      secretStore: new MemorySecretStore(),
      routeEpoch: 7,
      activationEpoch: 1,
    });

    expect(reads).toBe(1);
    expect(runtime.conversationId).toBe(CONVERSATION_ID);
    expect(Object.isFrozen(runtime.routes)).toBe(true);
    expect(runtime.routes.map((route) => route.chatId)).toEqual([OWNER_ID, OTHER_OWNER_ID]);
    for (const route of runtime.routes) {
      expect(route.actorDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(route.actorDigest).not.toContain(route.chatId);
      expect(route.binding.bridgeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(route.binding.routeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(route.binding.scope).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(route.binding.routeEpoch).toBe(7);
    }

    const route = runtime.routes[0]!;
    const authorization = await authorize(runtime, envelope());
    expect(authorization).not.toBeNull();
    expect(authorization?.actorDigest).toBe(route.actorDigest);
    expect(authorization?.bridgeBinding).toEqual(route.binding);
    expect(authorization?.conversationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(authorization?.conversationDigest).not.toContain(CONVERSATION_ID);
    expect(runtime.routeForEnvelope(envelope())).toBe(route);
  });

  it("revokes current routes and already-admitted guards on dispose", async () => {
    const { runtime } = createRuntime();
    const route = runtime.routes[0]!;
    const authorization = await authorize(runtime, envelope());
    expect(authorization?.bridgeGuard.isCurrent(authorization.bridgeBinding!)).toBe(true);
    expect(runtime.isRouteCurrent(route)).toBe(true);

    runtime.dispose();

    expect(runtime.isRouteCurrent(route)).toBe(false);
    expect(authorization?.bridgeGuard.isCurrent(authorization.bridgeBinding!)).toBe(false);
    expect(await authorize(runtime, envelope())).toBeNull();
    expect(runtime.routeForEnvelope(envelope())).toBeNull();
  });

  it("fences authorization and outbound routes when the captured conversation changes", async () => {
    const { runtime, current } = createRuntime();
    const route = runtime.routes[0]!;
    const authorization = await authorize(runtime, envelope());
    expect(authorization?.bridgeGuard.isCurrent(authorization.bridgeBinding!)).toBe(true);

    current.value = "conversation-switched";
    current.epoch += 1;

    expect(runtime.isRouteCurrent(route)).toBe(false);
    expect(authorization?.bridgeGuard.isCurrent(authorization.bridgeBinding!)).toBe(false);
    expect(await authorize(runtime, envelope())).toBeNull();
    expect(runtime.routeForEnvelope(envelope())).toBeNull();

    // Returning to the same id must not silently revive this old bridge.
    current.value = CONVERSATION_ID;
    expect(runtime.isRouteCurrent(route)).toBe(false);
    expect(authorization?.bridgeGuard.isCurrent(authorization.bridgeBinding!)).toBe(false);
    expect(await authorize(runtime, envelope())).toBeNull();
  });

  it("scopes route identity and conversation digest to the configured bot fingerprint", async () => {
    const secrets = new MemorySecretStore();
    const current = { value: CONVERSATION_ID, epoch: 0 };
    const first = createTelegramPlatformRuntime({
      allowedUserIds: [OWNER_ID],
      botFingerprint: BOT_FINGERPRINT,
      getCurrentConversationId: () => current.value,
      getCurrentConversationEpoch: () => current.epoch,
      secretStore: secrets,
      activationEpoch: 1,
    });
    const second = createTelegramPlatformRuntime({
      allowedUserIds: [OWNER_ID],
      botFingerprint: SECOND_BOT_FINGERPRINT,
      getCurrentConversationId: () => current.value,
      getCurrentConversationEpoch: () => current.epoch,
      secretStore: secrets,
      activationEpoch: 1,
    });

    const firstAuthorization = await authorize(first, envelope());
    const secondAuthorization = await authorize(second, envelope());
    expect(first.routes[0]?.actorDigest).not.toBe(second.routes[0]?.actorDigest);
    expect(first.routes[0]?.binding).not.toEqual(second.routes[0]?.binding);
    expect(firstAuthorization?.conversationDigest).not.toBe(secondAuthorization?.conversationDigest);
  });

  it("fences a reconnect: a later activation reuses the route key but not the binding", async () => {
    const secrets = new MemorySecretStore();
    const options = {
      allowedUserIds: [OWNER_ID],
      botFingerprint: BOT_FINGERPRINT,
      getCurrentConversationId: () => CONVERSATION_ID,
      getCurrentConversationEpoch: () => 0,
      secretStore: secrets,
    };
    const first = createTelegramPlatformRuntime({ ...options, activationEpoch: 1 });
    const second = createTelegramPlatformRuntime({ ...options, activationEpoch: 2 });

    const before = first.routes[0]!;
    const after = second.routes[0]!;
    // Same owner, same bot, same conversation: the durable receipt identity and
    // the delivery channel key must survive a reconnect...
    expect(after.actorDigest).toBe(before.actorDigest);
    expect(after.binding.routeId).toBe(before.binding.routeId);
    // ...while the binding itself must not, so a binding captured before the
    // disconnect cannot satisfy the guard afterwards.
    expect(after.binding.bridgeEpoch).not.toBe(before.binding.bridgeEpoch);
    expect(after.binding.scope).not.toBe(before.binding.scope);

    const authorization = await authorize(second, envelope());
    expect(authorization?.bridgeGuard.isCurrent(before.binding)).toBe(false);
    expect(authorization?.bridgeGuard.isCurrent(after.binding)).toBe(true);
  });

  it("accepts only an exact configured Telegram private-DM envelope", async () => {
    const { runtime } = createRuntime();

    expect(await authorize(runtime, envelope({ provider: "discord" }))).toBeNull();
    expect(await authorize(runtime, envelope({ senderId: OTHER_OWNER_ID }))).toBeNull();
    expect(await authorize(runtime, envelope({ channelId: OTHER_OWNER_ID }))).toBeNull();
    expect(await authorize(runtime, envelope({ channelId: "00123456789", senderId: "00123456789" }))).toBeNull();
    expect(await authorize(runtime, envelope({ channelId: "9007199254740992", senderId: "9007199254740992" }))).toBeNull();
    expect(await authorize(runtime, {
      ...envelope(),
      unexpected: "not admitted",
    } as unknown as PlatformBridgeVerifiedEnvelope)).toBeNull();
    expect(runtime.routeForEnvelope(envelope({ senderId: OTHER_OWNER_ID }))).toBeNull();
  });

  it("persists only a random actor secret, never Telegram or conversation plaintext", () => {
    const secrets = new RecordingSecretStore();
    const privateConversation = "conversation-do-not-persist";
    const privateOwner = "444444444";
    const botFingerprint = "c".repeat(64);
    createTelegramPlatformRuntime({
      allowedUserIds: [privateOwner],
      botFingerprint,
      getCurrentConversationId: () => privateConversation,
      getCurrentConversationEpoch: () => 0,
      secretStore: secrets,
      activationEpoch: 1,
    });

    expect([...secrets.values.keys()]).toEqual([TELEGRAM_PLATFORM_ACTOR_SECRET_NAME]);
    const persisted = [...secrets.values.values()].join("\n");
    expect(persisted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const plaintext of [privateOwner, privateConversation, botFingerprint]) {
      expect(persisted).not.toContain(plaintext);
    }
  });

  it("fails closed for missing, duplicate, non-canonical, or malformed owner configuration", () => {
    const base = {
      botFingerprint: BOT_FINGERPRINT,
      getCurrentConversationId: () => CONVERSATION_ID,
      getCurrentConversationEpoch: () => 0,
      secretStore: new MemorySecretStore(),
      activationEpoch: 1,
    };
    for (const allowedUserIds of [
      [],
      [OWNER_ID, OWNER_ID],
      ["0"],
      ["001234"],
      ["9007199254740992"],
    ]) {
      expect(() => createTelegramPlatformRuntime({ ...base, allowedUserIds })).toThrow(
        "telegram-platform-runtime-invalid",
      );
    }
    expect(() => createTelegramPlatformRuntime({
      ...base,
      allowedUserIds: [OWNER_ID],
      botFingerprint: BOT_FINGERPRINT.toUpperCase(),
    })).toThrow("telegram-platform-runtime-invalid");
    expect(() => createTelegramPlatformRuntime({
      ...base,
      allowedUserIds: [OWNER_ID],
      routeEpoch: 0,
    })).toThrow("telegram-platform-runtime-invalid");
    for (const activationEpoch of [0, -1, 1.5]) {
      expect(() => createTelegramPlatformRuntime({
        ...base,
        allowedUserIds: [OWNER_ID],
        activationEpoch,
      })).toThrow("telegram-platform-runtime-invalid");
    }
    expect(() => createTelegramPlatformRuntime({
      ...base,
      allowedUserIds: [OWNER_ID],
      getCurrentConversationId: () => "",
    })).toThrow("telegram-platform-runtime-current-conversation-unavailable");
  });

  it("rejects a stored actor secret that decrypts to the wrong shape", () => {
    const secrets = new MemorySecretStore();
    secrets.write(TELEGRAM_PLATFORM_ACTOR_SECRET_NAME, "short");
    expect(() => ensureTelegramPlatformActorSecret(secrets)).toThrow(
      "telegram-platform-runtime-actor-secret-invalid",
    );
  });
});

/**
 * The other corruption, and the one that actually happens: the ciphertext is
 * intact and this machine simply cannot decrypt it any more — an OS keychain
 * reset, or the app data restored onto a different machine.
 *
 * These drive the real `SafeStorageSecretStore` over a real directory with a
 * `SafeStorageLike` whose `decryptString` throws. `MemorySecretStore` cannot
 * express this at all: it returns whatever was written, so a suite built on it
 * could never observe the rotation below.
 */
describe("actor key rotation", () => {
  let directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories) await cleanupTmpDir(directory);
    directories = [];
  });

  function encryptedSecrets(): {
    readonly store: SecretStore;
    readonly dir: string;
    breakDecryption: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "lvis-telegram-actor-secret-"));
    directories.push(dir);
    const state = { broken: false };
    const encryption: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
      decryptString: (value: Buffer) => {
        if (state.broken) throw new Error("safeStorage could not decrypt this ciphertext");
        return value.toString("utf8").replace(/^enc:/, "");
      },
    };
    return {
      store: new SafeStorageSecretStore(encryption, dir),
      dir,
      breakDecryption: () => {
        state.broken = true;
      },
    };
  }

  const digesterOver = (secretStore: SecretStore) =>
    createTelegramActorDigester({ botFingerprint: BOT_FINGERPRINT, secretStore });

  it("mints a fresh secret when the stored one can no longer be decrypted", () => {
    const secrets = encryptedSecrets();
    const first = ensureTelegramPlatformActorSecret(secrets.store);
    // Positive control: while the ciphertext is readable the key is stable, so
    // the change below is the broken decryption and nothing else.
    expect(ensureTelegramPlatformActorSecret(secrets.store)).toBe(first);

    secrets.breakDecryption();
    const second = ensureTelegramPlatformActorSecret(secrets.store);

    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    // Quarantined, not deleted: the unreadable ciphertext is the evidence.
    expect(readdirSync(secrets.dir).some((name) => name.includes("quarantined"))).toBe(true);
  });

  it("renames every actor when the key rotates, so a stored pairing digest stops matching", () => {
    const secrets = encryptedSecrets();
    const before = digesterOver(secrets.store);
    const pairedActorDigest = before.digestFor(OWNER_ID);
    expect(pairedActorDigest).toMatch(/^[a-f0-9]{64}$/);

    // Positive control: a second digester over the same readable key answers
    // identically, which is what makes a persisted pairing usable at all.
    const same = digesterOver(secrets.store);
    expect(same.actorKeyDigest).toBe(before.actorKeyDigest);
    expect(same.digestFor(OWNER_ID)).toBe(pairedActorDigest);

    secrets.breakDecryption();
    const after = digesterOver(secrets.store);

    expect(after.actorKeyDigest).not.toBe(before.actorKeyDigest);
    expect(after.digestFor(OWNER_ID)).not.toBe(pairedActorDigest);
  });

  it("names the key with a digest that is neither the key nor any other derivation of it", () => {
    const secrets = encryptedSecrets();
    const actorSecret = ensureTelegramPlatformActorSecret(secrets.store);
    const digester = digesterOver(secrets.store);

    expect(digester.actorKeyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(digester.actorKeyDigest).not.toContain(actorSecret);
    // Pins the domain string: this mirror is the only other copy of it.
    expect(digester.actorKeyDigest).toBe(
      createHmac("sha256", actorSecret)
        .update("lvis/telegram-platform-bridge/actor-key/v1\0", "utf8")
        .digest("hex"),
    );
    // Same key, different domain — the two must not be interchangeable.
    expect(digester.actorKeyDigest).not.toBe(digester.digestFor(OWNER_ID));
    expect(digester.digestFor("not-a-telegram-id")).toBeNull();
  });
});

class RecordingSecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  read(name: string, maxBytes: number): string | null {
    void maxBytes;
    return this.values.get(name) ?? null;
  }

  write(name: string, value: string): void {
    this.values.set(name, value);
  }
}
