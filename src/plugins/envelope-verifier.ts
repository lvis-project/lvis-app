/**
 * S2 — Envelope-format signature verifier for marketplace binary delivery.
 *
 * Verifies the JSON envelope served at
 * `/api/v1/plugins/{slug}/download.sig`:
 *
 *   { "version": 1, "iat": <unix>, "artifact_sha256": "<hex>",
 *     "signatures": [{"key_id": "prod-v1", "alg": "ed25519", "sig": "<b64>"}] }
 *
 * Contract:
 *   - At least one signature must verify against a pub key in the supplied map
 *   - The envelope's `artifact_sha256` must match the computed tarball hash
 *   - The signature is over the RAW tarball bytes (NOT the hex digest). This
 *     matches the server's `signing.py` behavior — ed25519 signs raw bytes;
 *     encoding the sha256 in the envelope is purely an explicit integrity
 *     cross-check that callers can log/audit.
 *   - `alg` MUST be "ed25519"; other algorithms are rejected.
 *
 * Clock-skew guard lives in `marketplace-installer.ts` rather than here so
 * this module stays a pure crypto primitive.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { SignatureEnvelope, VerifyResult } from "./types.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("envelope-verifier");

/** Public key inputs may be raw 32-byte ed25519, SPKI DER, or SPKI PEM. */
export type PublicKeyInput = Buffer | string;

/**
 * Normalises supported public-key encodings to a KeyObject. We accept:
 *   - Buffer length 32 → raw ed25519 (constructed via JWK path)
 *   - Buffer (any other length) → DER SPKI
 *   - string starting with "-----BEGIN" → PEM SPKI
 *   - string (otherwise) → base64-decoded to buffer, re-dispatched
 */
export function toKeyObject(input: PublicKeyInput): KeyObject {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("-----BEGIN")) {
      return createPublicKey({ key: trimmed, format: "pem" });
    }
    // Assume base64 of SPKI DER.
    const buf = Buffer.from(trimmed, "base64");
    return toKeyObject(buf);
  }
  if (input.length === 32) {
    // Raw 32-byte ed25519 public key → JWK.
    return createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: input.toString("base64url") },
      format: "jwk",
    });
  }
  return createPublicKey({ key: input, format: "der", type: "spki" });
}

/**
 * Verifies `envelope.signatures` against `tarball`. Returns the first key_id
 * that successfully verifies. Short-circuits on mismatched `artifact_sha256`.
 */
export function verifyEnvelope(
  tarball: Buffer,
  envelope: SignatureEnvelope,
  publicKeys: Record<string, PublicKeyInput>,
): VerifyResult {
  // 0. Forward-compat: explicitly require envelope version 1. Fail closed on
  //    unknown versions so future envelope formats (with possibly different
  //    signing semantics) cannot be accepted accidentally by old clients.
  if (envelope?.version !== 1) {
    return { ok: false, reason: "unsupported envelope version" };
  }

  // 1. Integrity cross-check (envelope hash must match tarball hash).
  const computedSha256 = createHash("sha256").update(tarball).digest("hex");
  if (!envelope?.artifact_sha256 || envelope.artifact_sha256.toLowerCase() !== computedSha256) {
    return { ok: false, reason: "artifact_sha256 mismatch" };
  }

  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    return { ok: false, reason: "envelope contains no signatures" };
  }

  // 2. Try each signature against its corresponding public key. Iterate ALL
  //    signatures before returning to avoid leaking which key_id matched via
  //    timing side-channel.
  let matchedKeyId: string | undefined;
  for (const sig of envelope.signatures) {
    if (!sig || sig.alg !== "ed25519" || typeof sig.key_id !== "string" || typeof sig.sig !== "string") {
      continue;
    }
    const pub = publicKeys[sig.key_id];
    if (!pub) continue; // Unknown key id — caller's key map doesn't trust it.
    let keyObj: KeyObject;
    try {
      keyObj = toKeyObject(pub);
    } catch (err) {
      log.warn(
        `public key "${sig.key_id}" malformed — skipping: %s`,
        (err as Error).message,
      );
      continue;
    }
    let sigBytes: Buffer;
    try {
      sigBytes = Buffer.from(sig.sig, "base64");
    } catch {
      continue;
    }
    if (sigBytes.length !== 64) continue;
    try {
      if (verify(null, tarball, keyObj, sigBytes)) {
        // Preserve the FIRST matching key_id (doc contract).
        if (matchedKeyId === undefined) {
          matchedKeyId = sig.key_id;
        }
      }
    } catch (err) {
      log.warn(
        `verify() threw for key_id=${sig.key_id}: %s`,
        (err as Error).message,
      );
    }
  }

  if (matchedKeyId) {
    return { ok: true, key_id: matchedKeyId };
  }
  return { ok: false, reason: "no signature matched a trusted publisher key" };
}
