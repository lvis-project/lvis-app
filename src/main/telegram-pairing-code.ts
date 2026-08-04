/**
 * Single authority for the Telegram pairing code.
 *
 * Minting and redemption happen in different modules — the owner service mints,
 * the polling ingress redeems — so the digest derivation lives here rather than
 * in either of them. If the two ever computed it differently, a correct code
 * would silently fail to pair.
 *
 * The code is deliberately NOT slash-prefixed. The shared ingress core rejects
 * every leading-slash message unconditionally, so a `/start`-style code could
 * only be redeemed by branching that gate — which would create the first
 * privileged slash-command path in the host.
 */
import { createHash, randomBytes } from "node:crypto";
import { TELEGRAM_PAIRING_CODE } from "../shared/telegram-connection.js";

const CODE_PREFIX = "lvis-tg-v1.";
const CODE_ENTROPY_BYTES = 32;
const DIGEST_DOMAIN = "lvis/telegram-bridge/pairing-code/v1\0";

/** Mint one single-use pairing code. The caller persists only its digest. */
export function mintTelegramPairingCode(): string {
  const code = CODE_PREFIX + randomBytes(CODE_ENTROPY_BYTES).toString("base64url");
  if (!TELEGRAM_PAIRING_CODE.test(code)) {
    throw new Error("telegram-pairing-code-generation-invalid");
  }
  return code;
}

/**
 * Digest a candidate for constant-time comparison in the durable store.
 *
 * Anything that is not a well-formed code returns `null` rather than a digest
 * of arbitrary user text, so an ordinary message can never consume a pairing
 * attempt or reach the comparison at all.
 */
export function telegramPairingCodeDigest(candidate: string): string | null {
  if (typeof candidate !== "string" || !TELEGRAM_PAIRING_CODE.test(candidate)) return null;
  return createHash("sha256")
    .update(DIGEST_DOMAIN, "utf8")
    .update(candidate, "utf8")
    .digest("hex");
}

/**
 * Whether a message looks like a pairing code at all.
 *
 * The ingress consumes and drops every match, correct or not, so that a
 * near-miss credential never lands in the conversation transcript.
 */
export function looksLikeTelegramPairingCode(text: string): boolean {
  return typeof text === "string" && TELEGRAM_PAIRING_CODE.test(text.trim());
}
