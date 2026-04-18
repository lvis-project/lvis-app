import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Plugin Signature Verifier — Sprint 3-B §9.6 / §14.2
 *
 * Verifies the authenticity of a plugin manifest using an ed25519 detached
 * signature. Managed plugins MUST be signed by a trusted publisher key; user
 * plugins MAY be signed (a warning is logged when they are not).
 *
 * Contract:
 *   - Canonical bytes: the raw UTF-8 bytes of `manifest.json` (no re-parse).
 *   - Signature file: `manifest.json.sig` sibling to the manifest, containing
 *     the raw 64-byte ed25519 signature (binary) or the same bytes base64-
 *     encoded. We accept both to ease operator tooling.
 *   - Public key: a PEM-encoded ed25519 SPKI key supplied by the host (either
 *     bundled or cached under ~/.lvis/keys/).
 *
 * The SHA256 digest is computed alongside the verify() call purely so callers
 * can log/audit a stable content hash; `crypto.verify()` for ed25519 ignores
 * any provided digest and signs the raw bytes end-to-end.
 */

export interface SignatureVerificationResult {
  valid: boolean;
  sha256: string;
  reason?: string;
}

export interface SignatureVerifierOptions {
  /** Ed25519 SPKI public key in PEM form. Multiple accepted for rotation. */
  publisherPublicKeysPem: string[];
}

export class PluginSignatureVerifier {
  private readonly keys: KeyObject[];

  constructor(options: SignatureVerifierOptions) {
    if (!options.publisherPublicKeysPem || options.publisherPublicKeysPem.length === 0) {
      throw new Error("PluginSignatureVerifier requires at least one publisher public key");
    }
    this.keys = options.publisherPublicKeysPem.map((pem) => createPublicKey(pem));
  }

  /**
   * Verifies a manifest at `manifestPath` against the detached signature at
   * `${manifestPath}.sig`. Returns `{ valid: true }` iff any configured
   * publisher key accepts the signature.
   */
  async verifyManifestFile(manifestPath: string): Promise<SignatureVerificationResult> {
    const manifestBytes = await readFile(manifestPath);
    const sha256 = createHash("sha256").update(manifestBytes).digest("hex");

    let sigRaw: Buffer;
    try {
      sigRaw = await readFile(`${manifestPath}.sig`);
    } catch {
      return { valid: false, sha256, reason: "signature file missing" };
    }

    const signature = normalizeSignature(sigRaw);
    if (!signature) {
      return { valid: false, sha256, reason: "signature file malformed" };
    }

    for (const key of this.keys) {
      try {
        // ed25519 uses `null` for the digest argument — crypto signs raw bytes.
        if (verify(null, manifestBytes, key, signature)) {
          return { valid: true, sha256 };
        }
      } catch {
        // Try next key.
      }
    }
    return { valid: false, sha256, reason: "signature did not match any publisher key" };
  }
}

/**
 * Accepts either raw 64-byte ed25519 signatures or base64-encoded equivalents.
 * Returns null if the bytes cannot be coerced into a plausible signature.
 */
function normalizeSignature(raw: Buffer): Buffer | null {
  if (raw.length === 64) return raw;
  const text = raw.toString("utf-8").trim();
  if (/^[A-Za-z0-9+/=\s]+$/.test(text)) {
    try {
      const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64");
      if (decoded.length === 64) return decoded;
    } catch {
      return null;
    }
  }
  return null;
}
