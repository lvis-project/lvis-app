import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { maskSensitiveData } from "../dlp.js";
import { createDlpSafeUuid, dlpSafeCandidate, isSafeStructuralId } from "../dlp-safe-id.js";
import { UUID_PATTERN } from "../uuid.js";

const SAFE_UUID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
// A valid v4 UUID whose serialized form carries a Luhn-valid 16-digit window
// (first two groups + version group), so the converged detector flags it.
const UNSAFE_UUID = "00000023-0161-4299-a234-abcdefabcdef";
// Safe on its own — its longest digit run is 8 — but a Luhn-valid 16-digit
// window straddles the join once BOUNDARY_PREFIX is concatenated in front.
const PREFIX_BOUNDARY_UUID = "20000004-ab12-4abc-8def-abcdefabcdef";
const BOUNDARY_PREFIX = "sub-10000000";

describe("createDlpSafeUuid", () => {
  it("creates unique UUID values whose complete bare and prefixed forms pass DLP", () => {
    const bare = Array.from({ length: 64 }, () => createDlpSafeUuid());
    const prefixed = Array.from({ length: 64 }, () => createDlpSafeUuid("sub-abcd1234"));

    expect(new Set([...bare, ...prefixed]).size).toBe(128);
    for (const id of bare) {
      expect(id).toMatch(UUID_PATTERN);
      expect(maskSensitiveData(id).detections).toEqual([]);
    }
    for (const id of prefixed) {
      expect(id).toMatch(/^sub-abcd1234-/);
      expect(id.slice("sub-abcd1234-".length)).toMatch(UUID_PATTERN);
      expect(maskSensitiveData(id).detections).toEqual([]);
    }
  });

  it("retries a credit-card-shaped UUID instead of returning a masked identifier", () => {
    const makeUuid = vi.fn()
      .mockReturnValueOnce(UNSAFE_UUID)
      .mockReturnValueOnce(SAFE_UUID);

    expect(createDlpSafeUuid("", makeUuid)).toBe(SAFE_UUID);
    expect(makeUuid).toHaveBeenCalledTimes(2);
  });

  it("retries when only the final prefix boundary creates a DLP match", () => {
    expect(maskSensitiveData(PREFIX_BOUNDARY_UUID).detections).toEqual([]);
    expect(maskSensitiveData(BOUNDARY_PREFIX).detections).toEqual([]);
    expect(maskSensitiveData(`${BOUNDARY_PREFIX}-${PREFIX_BOUNDARY_UUID}`).detections)
      .not.toEqual([]);
    const makeUuid = vi.fn()
      .mockReturnValueOnce(PREFIX_BOUNDARY_UUID)
      .mockReturnValueOnce(SAFE_UUID);

    expect(createDlpSafeUuid(BOUNDARY_PREFIX, makeUuid))
      .toBe(`${BOUNDARY_PREFIX}-${SAFE_UUID}`);
    expect(makeUuid).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the bounded retry ceiling", () => {
    const makeUuid = vi.fn(() => UNSAFE_UUID);
    expect(() => createDlpSafeUuid("", makeUuid))
      .toThrow("[dlp-safe-uuid-exhausted]");
    expect(makeUuid).toHaveBeenCalledTimes(8);
  });

  it("rejects a sensitive prefix before generating an identifier", () => {
    const makeUuid = vi.fn(() => SAFE_UUID);
    expect(() => createDlpSafeUuid("010-1234-5678", makeUuid))
      .toThrow("[dlp-safe-uuid-prefix-rejected]");
    expect(makeUuid).not.toHaveBeenCalled();
  });

  it("locks every cross-agent UUID generation site to the shared safe generator", () => {
    const productionSources = [
      "../../api/a2a-subagent-handler.ts",
      "../../engine/conversation-loop.ts",
      "../../engine/subagent-runner.ts",
      "../../engine/turn/session.ts",
      "../../ipc/domains/chat.ts",
      "../../tools/agent-send.ts",
      "../../tools/agent-spawn.ts",
    ];
    for (const relativePath of productionSources) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source, relativePath).toContain("createDlpSafeUuid");
      expect(source, relativePath).not.toMatch(/\b(?:crypto\.)?randomUUID\s*\(/);
    }
  });
});

describe("dlpSafeCandidate", () => {
  it("returns the first draw the scanner accepts", () => {
    const draws = vi.fn()
      .mockReturnValueOnce(UNSAFE_UUID)
      .mockReturnValueOnce(SAFE_UUID);

    expect(dlpSafeCandidate(draws, 8)).toBe(SAFE_UUID);
    expect(draws).toHaveBeenCalledTimes(2);
  });

  it("hands the draw its attempt number so a deterministic generator can vary", () => {
    const seen: number[] = [];
    dlpSafeCandidate((attempt) => {
      seen.push(attempt);
      return attempt === 2 ? SAFE_UUID : UNSAFE_UUID;
    }, 8);

    expect(seen).toEqual([0, 1, 2]);
  });

  it("skips a rejected draw without spending a scan on it", () => {
    // `null` is how a caller says "this candidate is unusable for a reason the
    // scanner cannot see" — a malformed uuid, or a name already taken.
    const draws = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(SAFE_UUID);

    expect(dlpSafeCandidate(draws, 8)).toBe(SAFE_UUID);
  });

  it("returns null on exhaustion, leaving the error to the caller", () => {
    expect(dlpSafeCandidate(() => UNSAFE_UUID, 3)).toBeNull();
    expect(dlpSafeCandidate(() => null, 3)).toBeNull();
  });
});

describe("isSafeStructuralId", () => {
  it("accepts an opaque token up to the length bound", () => {
    expect(isSafeStructuralId(SAFE_UUID)).toBe(true);
    expect(isSafeStructuralId("a".repeat(256))).toBe(true);
    expect(isSafeStructuralId("ctx:child/1.2-3_4")).toBe(true);
  });

  it("rejects non-strings, the empty string and anything past the bound", () => {
    expect(isSafeStructuralId(undefined)).toBe(false);
    expect(isSafeStructuralId(null)).toBe(false);
    expect(isSafeStructuralId(42)).toBe(false);
    expect(isSafeStructuralId({})).toBe(false);
    expect(isSafeStructuralId("")).toBe(false);
    expect(isSafeStructuralId("a".repeat(257))).toBe(false);
  });

  // The task store and A2A handler copies rejected C0 controls and DEL; the
  // message codec copy additionally rejected C1 controls and the Unicode line
  // separators. The one predicate keeps the union, so every string any former
  // copy refused is still refused.
  it("rejects C0 control characters and DEL", () => {
    expect(isSafeStructuralId("abc\u0000def")).toBe(false);
    expect(isSafeStructuralId("abc\u001fdef")).toBe(false);
    expect(isSafeStructuralId("abc\ndef")).toBe(false);
    expect(isSafeStructuralId("abc\u007fdef")).toBe(false);
  });

  it("rejects C1 control characters and the Unicode line separators", () => {
    expect(isSafeStructuralId("abc\u0080def")).toBe(false);
    expect(isSafeStructuralId("abc\u0085def")).toBe(false);
    expect(isSafeStructuralId("abc\u009fdef")).toBe(false);
    expect(isSafeStructuralId("abc\u2028def")).toBe(false);
    expect(isSafeStructuralId("abc\u2029def")).toBe(false);
  });

  it("rejects an id the DLP scanner would mask", () => {
    expect(maskSensitiveData(UNSAFE_UUID).detections.length).toBeGreaterThan(0);
    expect(isSafeStructuralId(UNSAFE_UUID)).toBe(false);
  });
});
