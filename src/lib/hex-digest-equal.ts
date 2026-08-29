/**
 * Constant-time equality for two SHA-256 hex digests.
 *
 * WHY THIS IS ITS OWN MODULE. Five call sites wrote this comparison out, in
 * four layers with no shared parent nearer than `lib/`: the tailnet web-session
 * store, the tailnet pairing-share store, the telegram connection store, the
 * rationale invocation journal, and the rationale audit adapter. Three of them
 * gated the input on `/^[0-9a-f]{64}$/` first, each with its own copy of that
 * pattern under its own name; two went straight to `Buffer.from(value, "hex")`.
 *
 * WHY THE GATE IS NOT OPTIONAL. `Buffer.from(value, "hex")` does not reject a
 * malformed string, it TRUNCATES at the first byte it cannot decode, and it
 * yields an empty buffer when it cannot decode anything. `timingSafeEqual` then
 * answers about whatever survived:
 *
 *   Buffer.from("zz", "hex").length            === 0
 *   timingSafeEqual(empty, empty)              === true
 *   Buffer.from("abXX", "hex")                 -> <ab>
 *   Buffer.from("abYY", "hex")                 -> <ab>
 *
 * So an ungated comparator reports two DIFFERENT strings as equal whenever they
 * share a decodable prefix and fail at the same offset — and reports any two
 * wholly non-hex strings as equal outright. The two ungated copies gated a CSRF
 * check and a pairing-code check.
 *
 * Both operands being locally computed is what kept those two latent. That is
 * an invariant neither function stated and neither could enforce, which is
 * exactly the kind of thing a shared primitive should stop depending on.
 *
 * The length equality is checked before `timingSafeEqual` because that function
 * THROWS on unequal lengths rather than returning false. After the pattern gate
 * both operands are 32 bytes, so the check cannot fire; it stays as the thing
 * that makes that argument true rather than assumed.
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/**
 * Lowercase hex encoding of a 32-byte digest — SHA-256, or an HMAC over it.
 *
 * Strict on case: every digest this app mints is lowercase (`digest("hex")`),
 * so an uppercase value is not one of ours and is refused as such. A caller
 * that accepts a digest from an external party normalises it with
 * `.toLowerCase()` at that boundary and then checks it against this pattern.
 */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Whether `left` and `right` are the same SHA-256 hex digest, compared without
 * an early return on the first differing byte.
 *
 * Returns `false` for anything that is not 64 lowercase hex characters. That
 * refusal leaks nothing: a value of the wrong shape cannot be any digest a
 * caller holds, so answering from its shape is not a secret-dependent branch.
 */
export function timingSafeEqualHexDigest(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || !SHA256_HEX.test(left)) return false;
  if (typeof right !== "string" || !SHA256_HEX.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
