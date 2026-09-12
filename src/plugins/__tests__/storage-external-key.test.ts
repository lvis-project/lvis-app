import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSecretEncryption } from "../../data/node-secret-encryption.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { createPluginStorage } from "../storage.js";

let root: string;
let dataDir: string;
let keyFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lvis-plugin-external-key-"));
  dataDir = join(root, "plugin-data");
  mkdirSync(dataDir, { mode: 0o700 });
  keyFile = join(root, "external-key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
});
afterEach(async () => cleanupTmpDir(root));

describe("plugin storage with a configured external key", () => {
  it("round-trips real ciphertext and refuses wrong-key replacement without changing stored bytes", async () => {
    const encryption = createNodeSecretEncryption(keyFile);
    const storage = createPluginStorage("sample", dataDir, encryption);
    await storage.writeEncrypted("token", "plugin-credential");
    const before = readFileSync(join(dataDir, "token"));
    expect(before.includes(Buffer.from("plugin-credential"))).toBe(false);
    expect(await storage.readEncrypted("token")).toBe("plugin-credential");

    writeFileSync(keyFile, randomBytes(32));
    const other = createPluginStorage("sample", dataDir, createNodeSecretEncryption(keyFile));
    await expect(other.readEncrypted("token")).rejects.toThrow(/authentication failed/);
    await expect(other.writeEncrypted("token", "replacement")).rejects.toThrow(/authentication failed/);
    expect(readFileSync(join(dataDir, "token"))).toEqual(before);
    expect(await storage.readEncrypted("token")).toBe("plugin-credential");
  });

  it("preserves incompatible ciphertext and rejects missing encryption without plaintext fallback", async () => {
    const storage = createPluginStorage("sample", dataDir, createNodeSecretEncryption(keyFile));
    const before = Buffer.from("v10legacy-desktop-ciphertext");
    writeFileSync(join(dataDir, "token"), before, { mode: 0o600 });
    await expect(storage.readEncrypted("token")).rejects.toThrow(/unsupported encryption format/);
    await expect(storage.writeEncrypted("token", "replacement")).rejects.toThrow(/unsupported encryption format/);
    expect(readFileSync(join(dataDir, "token"))).toEqual(before);

    const unavailable = createPluginStorage("sample", dataDir, createNodeSecretEncryption());
    await expect(unavailable.readEncrypted("token")).rejects.toMatchObject({ code: "encryption-unavailable" });
    await expect(unavailable.writeEncrypted("token", "replacement")).rejects.toMatchObject({ code: "encryption-unavailable" });
    expect(readFileSync(join(dataDir, "token"))).toEqual(before);
  });
});
