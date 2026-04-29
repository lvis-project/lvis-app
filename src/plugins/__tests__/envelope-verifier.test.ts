/**
 * S2 — Unit tests for envelope-verifier.
 *
 * Covers issue #104 Copilot follow-up items:
 *   - envelope.version !== 1 is rejected (forward-compat guard)
 *   - when multiple signatures verify, the FIRST matching key_id is returned
 *     (documented contract, not an implementation accident)
 */
import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyEnvelope } from "../envelope-verifier.js";
import type { SignatureEnvelope } from "../types.js";

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).slice(-32);
  return { privateKey, pubBuffer: rawPub as Buffer };
}

function signRaw(body: Buffer, priv: ReturnType<typeof makeKeypair>["privateKey"]) {
  return sign(null, body, priv).toString("base64");
}

function sha256Hex(body: Buffer) {
  return createHash("sha256").update(body).digest("hex");
}

describe("verifyEnvelope — version guard", () => {
  const body = Buffer.from("artifact-body");
  const { privateKey, pubBuffer } = makeKeypair();

  it("rejects envelope with version !== 1 (version=2)", () => {
    const envelope = {
      version: 2,
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: sha256Hex(body),
      signatures: [
        { key_id: "k1", alg: "ed25519", sig: signRaw(body, privateKey) },
      ],
    } as unknown as SignatureEnvelope;
    const result = verifyEnvelope(body, envelope, { k1: pubBuffer });
    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toMatch(/version/i);
  });

  it("rejects envelope with missing version field", () => {
    const envelope = {
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: sha256Hex(body),
      signatures: [{ key_id: "k1", alg: "ed25519", sig: signRaw(body, privateKey) }],
    } as unknown as SignatureEnvelope;
    const result = verifyEnvelope(body, envelope, { k1: pubBuffer });
    expect(result.ok).toBe(false);
  });

  it("accepts envelope with version === 1", () => {
    const envelope: SignatureEnvelope = {
      version: 1,
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: sha256Hex(body),
      signatures: [
        { key_id: "k1", alg: "ed25519", sig: signRaw(body, privateKey) },
      ],
    };
    const result = verifyEnvelope(body, envelope, { k1: pubBuffer });
    expect(result.ok).toBe(true);
  });
});

describe("verifyEnvelope — first-matching-key_id contract", () => {
  it("returns the FIRST signature that verifies when multiple are valid", () => {
    const body = Buffer.from("artifact-body-multi");
    const { privateKey: p1, pubBuffer: pub1 } = makeKeypair();
    const { privateKey: p2, pubBuffer: pub2 } = makeKeypair();
    const envelope: SignatureEnvelope = {
      version: 1,
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: sha256Hex(body),
      signatures: [
        { key_id: "first-key", alg: "ed25519", sig: signRaw(body, p1) },
        { key_id: "second-key", alg: "ed25519", sig: signRaw(body, p2) },
      ],
    };
    // Both keys trusted — verifier must report the FIRST one.
    const result = verifyEnvelope(body, envelope, {
      "first-key": pub1,
      "second-key": pub2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key_id).toBe("first-key");
  });

  it("still returns first-matching when the first signature is invalid but the second is valid", () => {
    const body = Buffer.from("artifact-body-partial");
    const { privateKey: p1, pubBuffer: pub1 } = makeKeypair();
    const { privateKey: p2, pubBuffer: pub2 } = makeKeypair();
    // Mix: a signature from p1 wrapped under key_id "second-key" would fail
    // against pub2. Put a garbage sig first, a valid one second.
    const envelope: SignatureEnvelope = {
      version: 1,
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: sha256Hex(body),
      signatures: [
        { key_id: "bad-key", alg: "ed25519", sig: Buffer.alloc(64).toString("base64") },
        { key_id: "good-key", alg: "ed25519", sig: signRaw(body, p2) },
      ],
    };
    const result = verifyEnvelope(body, envelope, {
      "bad-key": pub1,
      "good-key": pub2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.key_id).toBe("good-key");
  });

  it("rejects when artifact_sha256 does not match the tarball", () => {
    const body = Buffer.from("artifact-body");
    const { privateKey, pubBuffer } = makeKeypair();
    const envelope: SignatureEnvelope = {
      version: 1,
      iat: Math.floor(Date.now() / 1000),
      artifact_sha256: sha256Hex(Buffer.from("different-body")),
      signatures: [
        { key_id: "k1", alg: "ed25519", sig: signRaw(body, privateKey) },
      ],
    };
    const result = verifyEnvelope(body, envelope, { k1: pubBuffer });
    expect(result.ok).toBe(false);
  });
});
