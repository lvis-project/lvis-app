import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createNodeSecretEncryption, SecretKeyFileError } from "../node-secret-encryption.js";
import { SecretDocumentStore, SecretEncryptionUnavailableError } from "../secret-document-store.js";

let root: string;
let keyFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lvis-external-key-"));
  keyFile = join(root, "key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
});
afterEach(async () => cleanupTmpDir(root));

describe("protected external key encryption", () => {
  it("encrypts independently on each write and authenticates empty and Unicode strings", () => {
    const encryption = createNodeSecretEncryption(keyFile);
    expect(encryption.getSelectedStorageBackend()).toBe("external_key");
    expect(encryption.isEncryptionAvailable()).toBe(true);
    for (const value of ["", "credential-비밀-🔐\n"]) {
      const first = encryption.encryptString(value);
      const second = encryption.encryptString(value);
      expect(first.equals(second)).toBe(false);
      expect(encryption.decryptString(first)).toBe(value);
      expect(createNodeSecretEncryption(keyFile).decryptString(second)).toBe(value);
      if (value) expect(first.includes(Buffer.from(value))).toBe(false);
    }
  });

  it("rejects a wrong key, changes to every envelope region, and truncated ciphertext", () => {
    const encryption = createNodeSecretEncryption(keyFile);
    const ciphertext = encryption.encryptString("protected-credential");
    const otherFile = join(root, "other-key");
    writeFileSync(otherFile, randomBytes(32), { mode: 0o600 });
    expect(() => createNodeSecretEncryption(otherFile).decryptString(ciphertext)).toThrow(/authentication failed/);
    for (let offset = 0; offset < ciphertext.length; offset += 1) {
      const changed = Buffer.from(ciphertext);
      changed[offset] ^= 1;
      expect(() => encryption.decryptString(changed)).toThrow();
    }
    for (let length = 0; length < ciphertext.length; length += 1) {
      expect(() => encryption.decryptString(ciphertext.subarray(0, length))).toThrow();
    }
    expect(() => encryption.decryptString(Buffer.from("v10legacy-desktop-ciphertext"))).toThrow(/unsupported encryption format/);
  });

  it("has no plaintext or key creation fallback when no key is configured", async () => {
    const before = readdirSync(root);
    const encryption = createNodeSecretEncryption();
    expect(encryption.isEncryptionAvailable()).toBe(false);
    expect(() => encryption.encryptString("secret")).toThrow(SecretEncryptionUnavailableError);
    expect(() => encryption.decryptString(Buffer.from("secret"))).toThrow(SecretEncryptionUnavailableError);
    const store = new SecretDocumentStore({ path: join(root, "secrets.json"), policy: "development", encryption });
    await expect(store.set("key", "secret")).rejects.toThrow(SecretEncryptionUnavailableError);
    expect(readdirSync(root).filter((name) => !name.endsWith(".lock-anchor"))).toEqual(before);
  });

  it("rejects relative, absent, directory, linked, oversized and unprotected key files without repair", () => {
    expect(() => createNodeSecretEncryption("key")).toThrow(/absolute/);
    expect(() => createNodeSecretEncryption(join(root, "missing"))).toThrow(SecretKeyFileError);
    expect(() => createNodeSecretEncryption(root)).toThrow(/regular file/);
    const symlink = join(root, "linked");
    symlinkSync(keyFile, symlink);
    expect(() => createNodeSecretEncryption(symlink)).toThrow(SecretKeyFileError);
    const hardlink = join(root, "hardlink");
    linkSync(keyFile, hardlink);
    expect(() => createNodeSecretEncryption(hardlink)).toThrow(/hard links/);
    for (const size of [0, 31, 33, 64]) {
      const path = join(root, `sized-${size}`);
      writeFileSync(path, randomBytes(size), { mode: 0o600 });
      expect(() => createNodeSecretEncryption(path)).toThrow(/exactly 32/);
    }
    for (const mode of [0o000, 0o200, 0o440, 0o640, 0o644, 0o700]) {
      const path = join(root, `mode-${mode}`);
      writeFileSync(path, randomBytes(32), { mode: 0o600 });
      chmodSync(path, mode);
      expect(() => createNodeSecretEncryption(path)).toThrow(SecretKeyFileError);
      expect(statSync(path).mode & 0o7777).toBe(mode);
    }
  });

  it("accepts an owner read-only key and pins it until the next startup", () => {
    chmodSync(keyFile, 0o400);
    const encryption = createNodeSecretEncryption(keyFile);
    const ciphertext = encryption.encryptString("secret");
    chmodSync(keyFile, 0o600);
    writeFileSync(keyFile, randomBytes(32));
    expect(encryption.decryptString(ciphertext)).toBe("secret");
    expect(() => createNodeSecretEncryption(keyFile).decryptString(ciphertext)).toThrow(/authentication failed/);
  });
});

describe("external-key secret documents", () => {
  const storeAt = (rootPath: string, encryption = createNodeSecretEncryption(keyFile)) => new SecretDocumentStore({
    path: join(rootPath, "secrets.json"), policy: "packaged", encryption,
  });

  it("persists authenticated ciphertext with its own encoding and preserves it across restart", async () => {
    const store = storeAt(root);
    await store.set("api", "server-secret");
    const bytes = readFileSync(store.path, "utf8");
    expect(JSON.parse(bytes).entries.api.encoding).toBe("external-key");
    expect(bytes).not.toContain("server-secret");
    expect(storeAt(root).getEncrypted("api")).toBe("server-secret");
    await expect(storeAt(root).migrate()).resolves.toBe(false);
    expect(readFileSync(store.path, "utf8")).toBe(bytes);
  });

  it("refuses reads, replacement, deletion and migration with the wrong or missing key", async () => {
    const store = storeAt(root);
    await store.set("api", "preserved");
    const before = readFileSync(store.path);
    const otherFile = join(root, "other-key");
    writeFileSync(otherFile, randomBytes(32), { mode: 0o600 });
    for (const encryption of [createNodeSecretEncryption(otherFile), createNodeSecretEncryption()]) {
      const other = storeAt(root, encryption);
      expect(() => other.get("api")).toThrow();
      expect(() => other.getEncrypted("api")).toThrow();
      await expect(other.set("api", "replacement")).rejects.toThrow();
      await expect(other.set("another", "replacement")).rejects.toThrow();
      await expect(other.delete("api")).rejects.toThrow();
      await expect(other.deleteMany(["api"])).rejects.toThrow();
      await expect(other.migrate()).rejects.toThrow();
      expect(readFileSync(store.path)).toEqual(before);
    }
  });

  it("refuses existing desktop and development documents without modifying their bytes or modes", async () => {
    const desktopValue = Buffer.from("desktop-ciphertext").toString("base64");
    const documents = [
      { api: desktopValue },
      { api: "plain:legacy" },
      { version: 1, entries: { api: { encoding: "safe-storage", value: desktopValue } } },
      { version: 1, entries: { api: { encoding: "plain-development", value: "legacy" } } },
    ];
    for (const [index, document] of documents.entries()) {
      const directory = join(root, String(index));
      mkdirSync(directory);
      const store = storeAt(directory);
      const before = `${JSON.stringify(document)}\n`;
      writeFileSync(store.path, before, { mode: 0o644 });
      await expect(store.migrate()).rejects.toThrow();
      await expect(store.set("another", "replacement")).rejects.toThrow();
      expect(readFileSync(store.path, "utf8")).toBe(before);
      expect(statSync(store.path).mode & 0o777).toBe(0o644);
    }
  });
});
