import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createNodeSecretEncryption } from "../../data/node-secret-encryption.js";
import { ensureTailnetPairedShareActorSecret } from "../../main/tailnet-paired-share-authorizer.js";
import { createHostSecretStore } from "../host-secret-store.js";

let root: string;
let keyFile: string;
let directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lvis-host-encrypted-secrets-"));
  keyFile = join(root, "external-key");
  directory = join(root, "secrets");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
});
afterEach(async () => cleanupTmpDir(root));

describe("host authority secret store", () => {
  it("preserves identity across restart and never regenerates it after wrong-key decryption", () => {
    const secretStore = createHostSecretStore(createNodeSecretEncryption(keyFile), directory);
    const identity = ensureTailnetPairedShareActorSecret(secretStore);
    expect(ensureTailnetPairedShareActorSecret(
      createHostSecretStore(createNodeSecretEncryption(keyFile), directory),
    )).toBe(identity);
    const files = readdirSync(directory);
    const original = readFileSync(join(directory, files[0]));
    writeFileSync(keyFile, randomBytes(32));
    const wrongKeyStore = createHostSecretStore(createNodeSecretEncryption(keyFile), directory);
    expect(() => ensureTailnetPairedShareActorSecret(wrongKeyStore)).toThrow(/could not be decrypted/);
    expect(readdirSync(directory)).toEqual(files);
    expect(readFileSync(join(directory, files[0]))).toEqual(original);
  });

  it("refuses unavailable keys, legacy formats and tampering without quarantine or overwrite", () => {
    const encryption = createNodeSecretEncryption(keyFile);
    const store = createHostSecretStore(encryption, directory);
    store.write("authority", "retained-value");
    const path = join(directory, "authority.safe-storage");
    const valid = readFileSync(path, "utf8");
    for (const bytes of ["legacy-plaintext", "safe:v1:" + Buffer.from("v10legacy-ciphertext").toString("base64"), valid.slice(0, -4) + "AAAA", valid + "!"]) {
      writeFileSync(path, bytes);
      expect(() => store.read("authority", 256)).toThrow();
      expect(() => store.write("authority", "replacement")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(readdirSync(directory)).toEqual(["authority.safe-storage"]);
    }
    const unavailable = createHostSecretStore(createNodeSecretEncryption(), directory);
    expect(() => unavailable.read("authority", 256)).toThrow(/not available/);
    expect(() => unavailable.write("authority", "replacement")).toThrow(/not available/);
  });

  it("preserves existing desktop quarantine and replacement behavior", () => {
    let unavailableCiphertext = false;
    const desktopEncryption = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret" as const,
      encryptString: (value: string) => Buffer.from(`sealed:${value}`),
      decryptString: (value: Buffer) => {
        if (unavailableCiphertext) throw new Error("decryption unavailable");
        return value.toString("utf8").slice("sealed:".length);
      },
    };
    const store = createHostSecretStore(desktopEncryption, directory);
    const first = ensureTailnetPairedShareActorSecret(store);
    unavailableCiphertext = true;
    expect(ensureTailnetPairedShareActorSecret(store)).not.toBe(first);
    expect(readdirSync(directory).some((name) => name.includes("quarantined"))).toBe(true);
  });
});
