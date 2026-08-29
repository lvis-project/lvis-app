/**
 * The shape gate is the whole point of this comparator, so these tests are
 * mostly about inputs that are NOT digests.
 *
 * Scope note, stated rather than implied: the two call sites that had no gate
 * (the tailnet CSRF check and the tailnet pairing-code check) are not reachable
 * with a malformed operand today — both validate shape upstream, one on the
 * request token and one when the invitation is read off disk. What follows
 * therefore bites on the primitive, not on a live exploit. That is exactly the
 * reason to put the gate in the primitive: the safety of those two rested on an
 * invariant that neither of them stated or could enforce.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex, timingSafeEqualHexDigest } from "../hex-digest-equal.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("timingSafeEqualHexDigest", () => {
  it("matches a digest against itself and refuses a different one", () => {
    expect(timingSafeEqualHexDigest(sha256("a"), sha256("a"))).toBe(true);
    expect(timingSafeEqualHexDigest(sha256("a"), sha256("b"))).toBe(false);
  });

  it("refuses two wholly non-hex strings that decode to nothing", () => {
    // Buffer.from("zz", "hex") is EMPTY, and timingSafeEqual(empty, empty) is
    // true, so an ungated comparator answered YES here.
    expect(timingSafeEqualHexDigest("zz", "zz")).toBe(false);
    expect(timingSafeEqualHexDigest("not-hex-at-all", "also-not-hex")).toBe(false);
    expect(timingSafeEqualHexDigest("", "")).toBe(false);
  });

  it("refuses two DIFFERENT strings that share a decodable prefix", () => {
    // Buffer.from truncates at the first undecodable pair rather than failing,
    // so both of these become the single byte 0xab. An ungated comparator
    // reported two visibly different values as the same digest.
    expect(timingSafeEqualHexDigest("abXX", "abYY")).toBe(false);
    expect(timingSafeEqualHexDigest(`${sha256("a").slice(0, 8)}!!tail`, `${sha256("a").slice(0, 8)}??other`)).toBe(false);
  });

  it("refuses anything that is not exactly 64 lowercase hex characters", () => {
    const good = sha256("a");
    expect(timingSafeEqualHexDigest(good.toUpperCase(), good.toUpperCase())).toBe(false);
    expect(timingSafeEqualHexDigest(good.slice(0, 62), good.slice(0, 62))).toBe(false);
    expect(timingSafeEqualHexDigest(`${good}00`, `${good}00`)).toBe(false);
    expect(timingSafeEqualHexDigest(` ${good.slice(1)}`, ` ${good.slice(1)}`)).toBe(false);
  });

  it("refuses non-strings without throwing", () => {
    const good = sha256("a");
    expect(timingSafeEqualHexDigest(undefined, good)).toBe(false);
    expect(timingSafeEqualHexDigest(good, null)).toBe(false);
    expect(timingSafeEqualHexDigest(Buffer.from(good, "hex"), good)).toBe(false);
    expect(timingSafeEqualHexDigest({ toString: () => good }, good)).toBe(false);
  });

  it("never throws on a length mismatch the way timingSafeEqual does", () => {
    expect(timingSafeEqualHexDigest(sha256("a"), "ab")).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("hashes a string as UTF-8 and bytes as-is, to 64 lowercase hex characters", () => {
    const text = "héllo";
    const expected = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    expect(sha256Hex(text)).toBe(expected);
    expect(sha256Hex(Buffer.from(text, "utf8"))).toBe(expected);
    expect(sha256Hex(new TextEncoder().encode(text))).toBe(expected);
    expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the digest the comparator accepts", () => {
    expect(timingSafeEqualHexDigest(sha256Hex("a"), sha256Hex("a"))).toBe(true);
    expect(timingSafeEqualHexDigest(sha256Hex("a"), sha256Hex("b"))).toBe(false);
  });
});
