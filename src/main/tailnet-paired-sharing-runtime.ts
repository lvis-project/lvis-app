/**
 * Main-process composition for explicit Tailnet pairing and scoped sharing.
 *
 * The actor HMAC key is always loaded through Electron safeStorage in
 * production. Pairing records themselves contain only digests and opaque ids.
 */
import { safeStorage } from "electron";
import {
  SafeStorageSecretStore,
  type SafeStorageLike,
  type SecretStore,
} from "../audit/hmac-chain.js";
import {
  createTailnetPairedShareAuthorizer,
  ensureTailnetPairedShareActorSecret,
  type TailnetPairedShareAuthorizer,
} from "./tailnet-paired-share-authorizer.js";
import {
  createTailnetPairingShareStore,
  type CreateTailnetPairingShareStoreOptions,
  type TailnetPairingShareStore,
} from "./tailnet-pairing-share-store.js";

export interface TailnetPairedSharingRuntime {
  readonly store: TailnetPairingShareStore;
  readonly authorizer: TailnetPairedShareAuthorizer;
}

export interface CreateTailnetPairedSharingRuntimeOptions {
  readonly getCurrentConversationId: () => string;
  /** Test-only injection; production uses OS-encrypted safeStorage. */
  readonly secretStore?: SecretStore;
  /** Test-only store options; production uses the encrypted-feature namespace. */
  readonly storeOptions?: CreateTailnetPairingShareStoreOptions;
  /** Test-only Electron safeStorage injection. */
  readonly encryption?: SafeStorageLike;
}

export async function createTailnetPairedSharingRuntime(
  options: CreateTailnetPairedSharingRuntimeOptions,
): Promise<TailnetPairedSharingRuntime> {
  if (typeof options.getCurrentConversationId !== "function") {
    throw new Error("tailnet-paired-sharing-current-conversation-unavailable");
  }
  const store = createTailnetPairingShareStore(options.storeOptions);
  await store.open();
  const secretStore = options.secretStore
    ?? new SafeStorageSecretStore(options.encryption ?? safeStorage);
  const actorSecret = ensureTailnetPairedShareActorSecret(secretStore);
  const authorizer = createTailnetPairedShareAuthorizer({
    store,
    actorSecret,
    getCurrentConversationId: options.getCurrentConversationId,
  });
  return Object.freeze({ store, authorizer });
}
