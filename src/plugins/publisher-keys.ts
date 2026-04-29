import { MARKETPLACE_PUBLIC_KEYS } from "./marketplace-keys.js";

/**
 * Embedded publisher keys as raw 32-byte Buffers, keyed by `key_id`. Consumed
 * by the marketplace artifact installer for envelope signature verification.
 */
export function getBundledPublicKeys(): Record<string, Buffer> {
  return Object.fromEntries(
    Object.entries(MARKETPLACE_PUBLIC_KEYS as Record<string, string>).map(([id, b64]) => {
      const buf = Buffer.from(b64, "base64");
      if (buf.length !== 32) {
        throw new Error(
          `Invalid embedded ed25519 public key for key_id="${id}": expected 32 raw bytes, got ${buf.length}`,
        );
      }
      return [id, buf];
    }),
  );
}
