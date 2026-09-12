import type { SecretEncryption } from "../data/secret-document-store.js";
import { SafeStorageSecretStore, type SecretStore } from "./hmac-chain.js";

/** A configured external key must never turn unreadable authority into a new identity. */
export function createHostSecretStore(encryption: SecretEncryption, dir?: string): SecretStore {
  return new SafeStorageSecretStore(
    encryption,
    dir,
    encryption.getSelectedStorageBackend() === "external_key" ? "reject" : "quarantine",
  );
}
