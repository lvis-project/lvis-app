import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { PluginSignatureVerifier } from "../signature-verifier.js";

/**
 * Sprint 3-B — PluginSignatureVerifier.
 *
 * We generate an in-test ed25519 keypair so the test is self-contained and
 * does not require committed fixtures.
 */
describe("PluginSignatureVerifier", () => {
  let testDir: string;
  let manifestPath: string;
  let publicKeyPem: string;
  let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

  beforeEach(async () => {
    testDir = join(tmpdir(), `lvis-sig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    manifestPath = join(testDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ id: "com.lge.signed", version: "1.0.0" }),
      "utf-8",
    );

    const keypair = generateKeyPairSync("ed25519");
    privateKey = keypair.privateKey;
    publicKeyPem = keypair.publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("accepts a manifest signed by a trusted publisher key", async () => {
    const manifestBytes = await readFileBuf(manifestPath);
    const signature = sign(null, manifestBytes, privateKey);
    await writeFile(`${manifestPath}.sig`, signature.toString("base64"));

    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const result = await verifier.verifyManifestFile(manifestPath);

    expect(result.valid).toBe(true);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a manifest whose signature does not match", async () => {
    // Sign with an unrelated key.
    const other = generateKeyPairSync("ed25519");
    const manifestBytes = await readFileBuf(manifestPath);
    const signature = sign(null, manifestBytes, other.privateKey);
    await writeFile(`${manifestPath}.sig`, signature.toString("base64"));

    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const result = await verifier.verifyManifestFile(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/did not match/);
  });

  it("rejects a manifest when the signature file is missing", async () => {
    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const result = await verifier.verifyManifestFile(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  it("accepts base64-encoded signature files (operator-friendly format)", async () => {
    const manifestBytes = await readFileBuf(manifestPath);
    const signature = sign(null, manifestBytes, privateKey);
    await writeFile(`${manifestPath}.sig`, signature.toString("base64"));

    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const result = await verifier.verifyManifestFile(manifestPath);

    expect(result.valid).toBe(true);
  });

  it("detects tampering — any byte change invalidates the signature", async () => {
    const manifestBytes = await readFileBuf(manifestPath);
    const signature = sign(null, manifestBytes, privateKey);
    await writeFile(`${manifestPath}.sig`, signature.toString("base64"));

    // Tamper with the manifest after signing.
    await writeFile(
      manifestPath,
      JSON.stringify({ id: "com.lge.signed", version: "1.0.1" }),
      "utf-8",
    );

    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const result = await verifier.verifyManifestFile(manifestPath);

    expect(result.valid).toBe(false);
  });

  // PR#44 HIGH: reject raw 64-byte binary signature files — only base64 is
  // accepted. A random 64-byte file must not be treated as a candidate sig.
  it("rejects a raw 64-byte binary signature file (base64-only policy)", async () => {
    const bogus = Buffer.alloc(64, 0xab);
    await writeFile(`${manifestPath}.sig`, bogus);

    const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
    const result = await verifier.verifyManifestFile(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed/);
  });

  // PR#44 HIGH: when a key throws during verify(), we log a warning and treat
  // the key as a non-match (do not silently swallow).
  it("logs a warning when a publisher key throws during verify() and still rejects", async () => {
    const manifestBytes = await readFileBuf(manifestPath);
    // Sign with a different key so the legitimate key won't accept it either.
    const other = generateKeyPairSync("ed25519");
    const signature = sign(null, manifestBytes, other.privateKey);
    await writeFile(`${manifestPath}.sig`, signature.toString("base64"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verifier = new PluginSignatureVerifier({ publisherPublicKeysPem: [publicKeyPem] });
      // Monkey-patch one of the internal keys so verify() throws on it.
      // @ts-expect-error accessing private for test
      const keys = verifier.keys as unknown[];
      keys[0] = { type: "public" }; // KeyObject-shaped but invalid → crypto.verify throws

      const result = await verifier.verifyManifestFile(manifestPath);
      expect(result.valid).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      const firstCallArgs = warnSpy.mock.calls[0]?.join(" ") ?? "";
      expect(firstCallArgs).toMatch(/signature-verifier/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

async function readFileBuf(path: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}
