/**
 * Demo activation codec — encrypts/decrypts a `.env.demo` file payload into
 * a single-line activation string that can be safely distributed to internal
 * organization users.
 *
 * Threat model (the *explicit* design — see PR description):
 *   - The activation string is published through an internal channel
 *     (Confluence / SharePoint / chat). It MUST NOT be plaintext because
 *     the embedded API key would be casually scrapable.
 *   - The decryption *passphrase* is baked into the LVIS binary. A determined
 *     reverse-engineer with both the binary AND the activation string can
 *     decrypt — this is acknowledged. The point is *2-factor delivery*: the
 *     casual scraper has neither, the corporate-distributed binary user has
 *     both. Real production secrets live in cloud-issued tokens, not here.
 *   - Therefore: the passphrase is reconstructed from obfuscated chunks at
 *     runtime so a `strings <binary>` sweep does not return the raw value.
 *     This is *defense in depth*, NOT cryptographic security.
 *
 * Cipher: AES-256-GCM with a random 12-byte IV. 16-byte auth tag is
 * appended to the ciphertext before base64 encoding so tampering or a wrong
 * passphrase produces a clean decrypt failure.
 *
 * Wire format: `LVIS-DEMO:v1:<base64url(iv || ciphertext || authTag)>`
 *   - `v1` lets us rotate the cipher / key derivation without breaking
 *     existing strings (just keep the v1 decode path alongside the new one).
 *   - `base64url` so the string is URL-safe and copy/paste-friendly (no `+`,
 *     `/`, or `=` padding to confuse chat clients that auto-link URLs).
 *
 * Why this file lives in `src/main/` (not `src/shared/`):
 *   - Only the main process decrypts. The renderer/preload never sees the
 *     passphrase. Putting it under main/ keeps the obfuscated chunks out of
 *     the renderer bundle.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Wire prefix — `LVIS-DEMO:v1:`. The `v1` version tag lets us evolve the
 * cipher later without breaking strings issued today. A `v2` decoder would
 * dispatch on the prefix and fall back to the v1 path when older strings
 * are pasted in.
 */
export const ACTIVATION_PREFIX = "LVIS-DEMO:v1:";

/**
 * Obfuscated passphrase fragments. Concatenated at runtime to reconstruct
 * the master passphrase. Not a security boundary — just defeats a naive
 * `strings <binary> | grep -i secret` sweep. The real boundary is *who has
 * the activation string*, not who has the binary.
 *
 * If the passphrase ever needs to rotate, bump ACTIVATION_PREFIX to `v2`,
 * add a v2 decode path that uses the new passphrase, and keep this v1 path
 * for backward compatibility until all distributed strings have been
 * re-issued.
 */
const PASS_CHUNKS: readonly string[] = Object.freeze([
  "lvis",
  "-demo",
  "-v1-",
  "axpg",
  "-hckt19",
  "-internal",
  "-2026",
]);

function passphrase(): string {
  // Reconstruct lazily — keeps the joined string off the heap until first use.
  return PASS_CHUNKS.join("");
}

/** Salt for scrypt key derivation. Fixed because the activation string IV
 *  already randomises per-payload; the salt is a domain separator, not a
 *  per-call random. */
const SALT = Buffer.from("lvis-demo-codec-v1-salt", "utf8");

function deriveKey(): Buffer {
  // 32 bytes for AES-256. scryptSync is synchronous + slow by design — we
  // accept the ~100ms cost on activate because activation is a once-per-user
  // event, not a hot path.
  return scryptSync(passphrase(), SALT, 32);
}

function toBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(s: string): Buffer {
  // Restore the `+`/`/` chars and pad back to a multiple of 4.
  const replaced = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = replaced.length % 4 === 0 ? "" : "=".repeat(4 - (replaced.length % 4));
  return Buffer.from(replaced + pad, "base64");
}

/**
 * Encrypt a `.env.demo` plaintext payload into a single-line activation
 * string. Suitable for distribution through an internal channel.
 *
 * The plaintext is the raw `.env.demo` file content — `KEY=VALUE` lines,
 * comments, blank lines, all preserved. The codec is intentionally
 * format-agnostic so future `.env.demo` schema changes do not require
 * re-issuing the codec, just re-issuing activation strings.
 */
export function encryptActivationPayload(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("plaintext must be a non-empty string");
  }
  const iv = randomBytes(12); // 96-bit IV is the GCM canonical size
  const key = deriveKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Layout: iv (12) || ciphertext (N) || authTag (16)
  const blob = Buffer.concat([iv, ciphertext, authTag]);
  return `${ACTIVATION_PREFIX}${toBase64Url(blob)}`;
}

/**
 * Decrypt an activation string back into its `.env.demo` plaintext.
 *
 * Throws on:
 *   - missing/wrong prefix
 *   - corrupt base64
 *   - GCM auth tag mismatch (wrong passphrase OR tampered ciphertext)
 *
 * Callers catch and translate the throw into the IPC `invalid-code` error
 * — the renderer surfaces a Korean message but the IPC payload stays
 * machine-readable per CLAUDE.md error-language rule.
 */
export function decryptActivationCode(code: string): string {
  if (typeof code !== "string" || code.length === 0) {
    throw new Error("activation code must be a non-empty string");
  }
  // Tolerate surrounding whitespace from copy-paste (newlines, trailing
  // spaces). Reject anything else as malformed.
  const trimmed = code.trim();
  if (!trimmed.startsWith(ACTIVATION_PREFIX)) {
    throw new Error("activation code missing expected prefix");
  }
  const payload = trimmed.slice(ACTIVATION_PREFIX.length);
  if (payload.length === 0) {
    throw new Error("activation code payload is empty");
  }
  const blob = fromBase64Url(payload);
  // iv (12) + authTag (16) = 28 bytes minimum, plus at least 1 ciphertext byte.
  if (blob.length < 12 + 16 + 1) {
    throw new Error("activation code payload too short");
  }
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const key = deriveKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  const text = plaintext.toString("utf8");
  if (text.length === 0) {
    throw new Error("decrypted activation payload is empty");
  }
  return text;
}

/**
 * Parse a `.env.demo` plaintext block into key/value pairs. Mirrors the
 * loader in `scripts/run-electron.mjs` so the *same* file shape is accepted
 * whether the user dropped the file in the repo root OR pasted an
 * activation string.
 *
 * Skips:
 *   - empty lines
 *   - lines starting with `#`
 * Strips:
 *   - leading `export ` prefix
 *   - surrounding double/single quotes around values
 *
 * The returned map is a plain object so callers can spread it into
 * `process.env` directly. Keys with empty values are *included* (the
 * `.env.demo` file may legitimately set `LVIS_DEMO_HOST_MAP=` to clear a
 * previously-applied mapping).
 */
export function parseEnvDemoText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.replace(/^export\s+/, "");
    const eq = stripped.indexOf("=");
    if (eq < 1) continue;
    const key = stripped.slice(0, eq).trim();
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key.length > 0) {
      out[key] = val;
    }
  }
  return out;
}
