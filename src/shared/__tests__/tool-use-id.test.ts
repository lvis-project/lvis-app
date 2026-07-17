import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_USE_ID_UTF8_BYTES,
  assertValidToolUseId,
  isValidToolUseId,
} from "../tool-use-id.js";

describe("tool-use ID validation", () => {
  it("accepts a nonempty ID at the 256-byte UTF-8 boundary", () => {
    const value = "😀".repeat(64);
    expect(new TextEncoder().encode(value)).toHaveLength(MAX_TOOL_USE_ID_UTF8_BYTES);
    expect(isValidToolUseId(value)).toBe(true);
    expect(() => assertValidToolUseId(value)).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["over UTF-8 byte limit", "😀".repeat(65)],
    ["NUL", "unsafe\u0000secret"],
    ["C0", "unsafe\nsecret"],
    ["C1", "unsafe\u0085secret"],
  ])("rejects %s without reflecting the value in the error", (_label, value) => {
    expect(isValidToolUseId(value)).toBe(false);
    let message = "";
    try {
      assertValidToolUseId(value);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("tool use ID is invalid");
    expect(message).not.toContain("unsafe");
    expect(message).not.toContain("secret");
  });
});
