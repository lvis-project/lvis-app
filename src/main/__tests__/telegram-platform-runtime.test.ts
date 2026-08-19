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
import {
  createTelegramActorDigester,
  ensureTelegramPlatformActorSecret,
  TELEGRAM_PLATFORM_ACTOR_SECRET_NAME,
} from "../telegram-platform-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const OWNER_ID = "123456789";
const BOT_FINGERPRINT = "a".repeat(64);

describe("Telegram platform actor secret", () => {
  it("persists only a random actor secret, never any Telegram plaintext", () => {
    const secrets = new RecordingSecretStore();
    ensureTelegramPlatformActorSecret(secrets);

    expect([...secrets.values.keys()]).toEqual([TELEGRAM_PLATFORM_ACTOR_SECRET_NAME]);
    const persisted = [...secrets.values.values()].join("\n");
    expect(persisted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(persisted).not.toContain(BOT_FINGERPRINT);
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
