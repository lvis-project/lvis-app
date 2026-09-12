import { safeStorage } from "electron";
import type { SecretEncryption } from "../data/secret-document-store.js";

/** Electron exposes its backend name only on Linux; other hosts report it as unknown. */
export const desktopSecretEncryption: SecretEncryption = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  getSelectedStorageBackend: () => process.platform === "linux"
    ? safeStorage.getSelectedStorageBackend() : "unknown",
  encryptString: (value) => safeStorage.encryptString(value),
  decryptString: (value) => safeStorage.decryptString(value),
};
