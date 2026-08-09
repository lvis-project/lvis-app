/**
 * What happens to a durable Telegram pairing when this machine loses the local
 * key its actor digests were derived under.
 *
 * The dominant real causes are an OS keychain reset and restoring the app data
 * onto another machine. Both surface as a decrypt failure, which
 * `SafeStorageSecretStore` answers with null, so the platform runtime mints a
 * fresh key and every actor digest changes. Without a guard that is silent: the
 * paired owner stops being recognised and the settings surface still says
 * "paired".
 *
 * Everything here runs the production pieces — the real encrypted secret store
 * over a real directory, the real connection store over a real feature
 * namespace, the real paired runtime — because the defect lived exactly in the
 * seam between them.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SafeStorageSecretStore,
  type SafeStorageLike,
  type SecretStore,
} from "../../audit/hmac-chain.js";
import { reconcileTelegramActorKey } from "../telegram-connection-activation.js";
import { createTelegramConnectionService } from "../telegram-connection-service.js";
import {
  createTelegramConnectionStore,
  type TelegramConnectionStore,
} from "../telegram-connection-store.js";
import {
  createTelegramActorDigester,
  createTelegramPairedPlatformRuntime,
  ensureTelegramPlatformActorSecret,
  telegramConversationDigest,
} from "../telegram-platform-runtime.js";
import { namespaceAt } from "./telegram-connection-namespace.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const OWNER_ID = "776655443322";
const BOT_FINGERPRINT = "a".repeat(64);
const CONVERSATION_ID = "sentinel-conversation-shared-by-the-owner";
const FILE_NAME = "connection.json";
const CODE_DIGEST = "c".repeat(64);

let directories: string[] = [];

afterEach(async () => {
  for (const directory of directories) await cleanupTmpDir(directory);
  directories = [];
});

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * The real encrypted store, plus the one failure a memory-backed double cannot
 * express: the ciphertext stays exactly as written and only this machine's
 * ability to decrypt it goes away.
 */
function encryptedSecrets(): { readonly store: SecretStore; breakDecryption: () => void } {
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
    store: new SafeStorageSecretStore(encryption, tempDirectory("lvis-telegram-rotation-secrets-")),
    breakDecryption: () => {
      state.broken = true;
    },
  };
}

async function openStore(directory: string): Promise<TelegramConnectionStore> {
  const store = createTelegramConnectionStore({
    namespace: namespaceAt(directory),
    conversationDigestFor: telegramConversationDigest,
  });
  await store.open();
  return store;
}

/** Pair the owner and share the conversation they have open. */
async function pairAndShare(store: TelegramConnectionStore, actorDigest: string): Promise<void> {
  await store.createPendingCode({ codeDigest: CODE_DIGEST });
  expect(await store.completePairing({ codeDigest: CODE_DIGEST, actorDigest })).not.toBeNull();
  expect(await store.createApproval({
    conversationId: CONVERSATION_ID,
    conversationDigest: telegramConversationDigest(BOT_FINGERPRINT, CONVERSATION_ID),
  })).not.toBeNull();
}

/**
 * The production order, which is what makes a pairing nameable at all:
 * activation adopts the key before the bridge exists, so no code can be
 * redeemed until the document knows which key its digests will belong to.
 */
async function connectedAndPaired(
  store: TelegramConnectionStore,
  secretStore: SecretStore,
): Promise<void> {
  await store.setConnected(BOT_FINGERPRINT);
  await reconcile(store, secretStore);
  const digester = createTelegramActorDigester({ botFingerprint: BOT_FINGERPRINT, secretStore });
  await pairAndShare(store, digester.digestFor(OWNER_ID)!);
}

/** The runtime as activation composes it, over whichever key is loadable now. */
function pairedRuntime(store: TelegramConnectionStore, secretStore: SecretStore) {
  return createTelegramPairedPlatformRuntime({
    botFingerprint: BOT_FINGERPRINT,
    authority: {
      activePairingActorDigest: () => store.activePairingActorDigest(),
      resolveActiveApproval: (actorDigest, conversationDigest) =>
        store.resolveActiveApproval(actorDigest, conversationDigest),
      resolveBoundConversation: (actorDigest) => store.resolveBoundConversation(actorDigest),
    },
    getCurrentConversationId: () => CONVERSATION_ID,
    activationEpoch: 1,
    secretStore,
  });
}

function ownerEnvelope() {
  return {
    provider: "telegram" as const,
    deliveryId: "telegram-update-4471",
    channelId: OWNER_ID,
    senderId: OWNER_ID,
    text: "are you there?",
  };
}

/** The production step, over whichever key this machine can load right now. */
async function reconcile(store: TelegramConnectionStore, secretStore: SecretStore): Promise<void> {
  await reconcileTelegramActorKey({ store, secretStore });
}

/**
 * The service as `main.ts` composes it, minus the parts a boot resume with no
 * credential never reaches. A bridge start here would be the defect: this
 * resume must give up at the missing token, and it must already have
 * reconciled by then.
 */
function connectionService(store: TelegramConnectionStore, secretStore: SecretStore) {
  return createTelegramConnectionService({
    store,
    settingsService: {
      setSecret: async () => {},
      // The keychain reset took the bot token along with the actor key.
      getEncryptedSecret: () => null,
      deleteSecret: async () => {},
      isSecretStorageEncrypted: () => true,
    },
    bridgeControl: {
      start: async () => {
        throw new Error("the bridge must not start without a credential");
      },
      stop: async () => {},
    },
    reconcileActorKey: () => reconcileTelegramActorKey({ store, secretStore }),
    getCurrentConversationId: () => CONVERSATION_ID,
    conversationDigestFor: (conversationId: string) =>
      telegramConversationDigest(BOT_FINGERPRINT, conversationId),
    conversationExists: () => true,
    envManaged: false,
  });
}

describe("telegram actor key rotation", () => {
  it("keeps the paired owner authorized while the actor key is still readable", async () => {
    const secrets = encryptedSecrets();
    const store = await openStore(tempDirectory("lvis-telegram-rotation-store-"));
    await connectedAndPaired(store, secrets.store);

    // A second activation over the same readable key changes nothing.
    await reconcile(store, secrets.store);

    const snapshot = store.ownerSnapshot();
    expect(snapshot.pairing).not.toBeNull();
    expect(snapshot.pairingUnrecognized).toBe(false);
    expect(snapshot.approval).not.toBeNull();
    expect(pairedRuntime(store, secrets.store).authorize(ownerEnvelope())).not.toBeNull();
  });

  it("retires the pairing and refuses the owner once the actor key has rotated", async () => {
    const secrets = encryptedSecrets();
    const store = await openStore(tempDirectory("lvis-telegram-rotation-store-"));
    await connectedAndPaired(store, secrets.store);

    secrets.breakDecryption();
    await reconcile(store, secrets.store);

    const snapshot = store.ownerSnapshot();
    // The surface must stop claiming an account it can no longer name...
    expect(snapshot.pairing).toBeNull();
    // ...and say which of the two "not paired" situations this is.
    expect(snapshot.pairingUnrecognized).toBe(true);
    expect(snapshot.approval).toBeNull();
    expect(store.activePairingActorDigest()).toBeNull();
    expect(pairedRuntime(store, secrets.store).authorize(ownerEnvelope())).toBeNull();
  });

  it("reconciles before the bot token is read on the composed boot resume", async () => {
    const secrets = encryptedSecrets();
    const store = await openStore(tempDirectory("lvis-telegram-rotation-store-"));
    await connectedAndPaired(store, secrets.store);
    // One keychain reset takes both secrets: the token this resume needs and
    // the key the pairing's digests were minted under.
    secrets.breakDecryption();

    // Through the composition boot actually runs, not around it. The resume
    // gives up at the missing credential, and everything the bridge would have
    // done — the reconcile included — is downstream of that return.
    await connectionService(store, secrets.store).resumeStoredConnection();

    expect(store.ownerSnapshot().pairing).toBeNull();
    expect(store.ownerSnapshot().pairingUnrecognized).toBe(true);
    // The resume still reports its own failure; the reconcile does not mask it.
    expect(store.ownerSnapshot().lastErrorCode).toBe("telegram-bot-token-unreadable");
  });

  it("round-trips the actor key digest without ever writing the key itself", async () => {
    const secrets = encryptedSecrets();
    const directory = tempDirectory("lvis-telegram-rotation-store-");
    const store = await openStore(directory);
    const actorSecret = ensureTelegramPlatformActorSecret(secrets.store);
    const digester = createTelegramActorDigester({
      botFingerprint: BOT_FINGERPRINT,
      secretStore: secrets.store,
    });
    await connectedAndPaired(store, secrets.store);

    const persisted = readFileSync(join(directory, FILE_NAME), "utf8");
    expect(JSON.parse(persisted).actorKeyDigest).toBe(digester.actorKeyDigest);
    expect(persisted).not.toContain(actorSecret);
    expect(persisted).not.toContain(OWNER_ID);

    // Survives the restart it exists for: a reopened document reconciles clean
    // against the same key rather than re-reporting a rotation.
    const reopened = await openStore(directory);
    expect(await reopened.reconcileActorKey(digester.actorKeyDigest)).toBe(false);
    expect(reopened.ownerSnapshot().pairing).not.toBeNull();
  });

  it("treats an absent stored digest with a live pairing as unrecognized, not as adoption", async () => {
    const secrets = encryptedSecrets();
    const store = await openStore(tempDirectory("lvis-telegram-rotation-store-"));
    const digester = createTelegramActorDigester({
      botFingerprint: BOT_FINGERPRINT,
      secretStore: secrets.store,
    });
    // Deliberately skipping the adoption activation performs, which is the
    // shape of a document written before the field existed, or edited by hand.
    await store.setConnected(BOT_FINGERPRINT);
    await pairAndShare(store, digester.digestFor(OWNER_ID)!);

    // Nothing named the key, so this store cannot show that the stored digest
    // is still derivable — the same evidence gap as a rotation.
    expect(await store.reconcileActorKey(digester.actorKeyDigest)).toBe(true);
    expect(store.ownerSnapshot().pairingUnrecognized).toBe(true);

    // Adoption is only for a document with nothing to lose.
    const fresh = await openStore(tempDirectory("lvis-telegram-rotation-store-"));
    await fresh.setConnected(BOT_FINGERPRINT);
    expect(await fresh.reconcileActorKey(digester.actorKeyDigest)).toBe(false);
    expect(fresh.ownerSnapshot().pairingUnrecognized).toBe(false);
  });
});
