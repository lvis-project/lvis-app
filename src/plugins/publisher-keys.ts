/**
 * Bundled publisher public keys for plugin manifest signature verification.
 *
 * AP-1 follow-up: this module now consumes `MARKETPLACE_PUBLIC_KEYS` from
 * `@lvis/plugin-sdk/keys` (v1.0.1) — the single source of truth for trusted
 * marketplace signing keys. Key rotation is now managed by bumping the SDK
 * submodule rather than hand-editing arrays here.
 *
 * The SDK ships raw 32-byte ed25519 public keys (base64) keyed by `key_id`.
 * The host's `PluginSignatureVerifier` consumes PEM SPKI strings, so this
 * module converts each raw key into its PEM SPKI form at import time.
 *
 * Managed plugins whose `.sig` cannot be verified against any key here are
 * fail-closed (not loaded) unless the dev escape hatch `LVIS_DEV_SKIP_SIG=1`
 * is set. User plugins with missing signatures still load with a warning.
 */

import { createPublicKey } from "node:crypto";
import { MARKETPLACE_PUBLIC_KEYS as RAW_MARKETPLACE_PUBLIC_KEYS } from "@lvis/plugin-sdk/keys";

/** Locally-typed alias — SDK export returns `unknown` per-value; narrow once. */
const MARKETPLACE_PUBLIC_KEYS: Record<string, string> =
  RAW_MARKETPLACE_PUBLIC_KEYS as Record<string, string>;

/**
 * Ed25519 SPKI DER prefix (12 bytes): SEQUENCE, length, SEQUENCE, OID
 * 1.3.101.112, BIT STRING, 0 unused bits. Followed by the 32-byte raw key.
 * See RFC 8410 §4.
 */
const ED25519_SPKI_DER_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function rawEd25519ToPem(rawBase64: string): string {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `Invalid ed25519 public key length: expected 32 bytes, got ${raw.length}`,
    );
  }
  const spkiDer = Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]);
  const key = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  return key.export({ type: "spki", format: "pem" }).toString();
}

/**
 * Bundled publisher keys as raw 32-byte Buffers, keyed by `key_id`. Exposed
 * for the marketplace artifact installer (consumes raw ed25519 keys for
 * envelope signature verification — see AP-1 FU installFromMarketplace wire
 * once S2 lands).
 */
export function getBundledPublicKeys(): Record<string, Buffer> {
  return Object.fromEntries(
    Object.entries(MARKETPLACE_PUBLIC_KEYS).map(([id, b64]) => {
      const buf = Buffer.from(b64, "base64");
      if (buf.length !== 32) {
        throw new Error(
          `Invalid bundled ed25519 public key for key_id="${id}": expected 32 raw bytes, got ${buf.length}`,
        );
      }
      return [id, buf];
    }),
  );
}

/**
 * Host-bundled publisher public keys in PEM SPKI form. Consumed by
 * `PluginSignatureVerifier` (manifest signature path). The verifier accepts
 * a signature that matches ANY configured key — additive rotation is safe.
 */
export const BUNDLED_PUBLISHER_PUBLIC_KEYS: string[] =
  Object.values(MARKETPLACE_PUBLIC_KEYS).map(rawEd25519ToPem);
