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
    this.keys = (options.publisherPublicKeysPem ?? []).map((pem) => createPublicKey(pem));
  }

  /**
   * Verifies a manifest at `manifestPath` against the detached signature at
   * `${manifestPath}.sig`. Returns `{ valid: true }` iff any configured
   * publisher key accepts the signature.
   */
  async verifyManifestFile(manifestPath: string): Promise<SignatureVerificationResult> {
    const manifestBytes = await readFile(manifestPath);
    const sha256 = createHash("sha256").update(manifestBytes).digest("hex");

    if (this.keys.length === 0) {
      return { valid: false, sha256, reason: "no publisher public keys configured" };
    }

    let sigRaw: Buffer;
    try {
      sigRaw = await readFile(`${manifestPath}.sig`);
    } catch (err) {
      // PR#44 Copilot: differentiate ENOENT (truly missing) from any other
      // filesystem failure (permissions, EIO, etc.) so operators can tell the
      // difference between "not signed yet" and "we couldn't read it".
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { valid: false, sha256, reason: "signature file missing" };
      }
      return {
        valid: false,
        sha256,
        reason: `signature file io-error: ${code ?? "unknown"} — ${(err as Error).message}`,
      };
    }

    const signature = normalizeSignature(sigRaw);
    if (!signature) {
      return { valid: false, sha256, reason: "signature file malformed" };
    }

    // PR#44 HIGH: iterate ALL keys before returning to avoid leaking which
    // key matched via timing side-channel. Accumulate a boolean; do not
    // early-return on first match. Also log malformed-key errors (instead of
    // silently swallowing) so operators can spot misconfigured keys.
    let matched = false;
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i];
      try {
        // ed25519 uses `null` for the digest argument — crypto signs raw bytes.
        if (verify(null, manifestBytes, key, signature)) {
          matched = true;
        }
      } catch (err) {
        console.warn(
          `[signature-verifier] key #${i} verify() threw — treating as non-match:`,
          (err as Error).message,
        );
      }
    }
    if (matched) {
      return { valid: true, sha256 };
    }
    return { valid: false, sha256, reason: "signature did not match any publisher key" };
  }
}

/**
 * Accepts base64-encoded ed25519 signatures only. The raw-64-byte-detection
 * branch was removed (PR#44 HIGH) — any 64-byte file was being treated as a
 * candidate signature, which is too permissive. Operators must base64-encode
 * the detached signature; we reject anything whose decoded length is not
 * exactly 64 bytes.
 */
function normalizeSignature(raw: Buffer): Buffer | null {
  const text = raw.toString("utf-8").trim();
  if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return null;
  try {
    const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64");
    if (decoded.length === 64) return decoded;
  } catch {
    return null;
  }
  return null;
}
