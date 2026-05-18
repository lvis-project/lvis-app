import { describe, it, expect } from "vitest";
import {
  isLLMVendor,
  LLM_VENDORS,
  LLM_VENDOR_DEFAULTS,
  freshVendorBlocks,
} from "../llm-vendor-defaults.js";

describe("isLLMVendor", () => {
  it("accepts every member of LLM_VENDORS", () => {
    for (const v of LLM_VENDORS) {
      expect(isLLMVendor(v)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isLLMVendor("anthropic")).toBe(false);
    expect(isLLMVendor("unknown-vendor")).toBe(false);
    expect(isLLMVendor("openai-compatible")).toBe(false);
    expect(isLLMVendor("")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isLLMVendor(undefined)).toBe(false);
    expect(isLLMVendor(null)).toBe(false);
    expect(isLLMVendor(42)).toBe(false);
    expect(isLLMVendor({ vendor: "claude" })).toBe(false);
    expect(isLLMVendor(["claude"])).toBe(false);
    expect(isLLMVendor(true)).toBe(false);
  });

  it("narrows the type so downstream callers receive a typed LLMVendor", () => {
    // Compile-time proof: passing `raw` to a function whose parameter is
    // typed `LLMVendor` only succeeds when the guard has narrowed it.
    // No hand-written exhaustive map needed — the call site itself is the
    // proof, and a future vendor added to LLM_VENDORS does not invalidate
    // this test.
    const acceptVendor = (v: import("../llm-vendor-defaults.js").LLMVendor) => v;
    const raw: unknown = "claude";
    if (isLLMVendor(raw)) {
      expect(acceptVendor(raw)).toBe("claude");
    } else {
      expect.fail("raw should have narrowed to LLMVendor");
    }
  });
});

describe("LLMVendorSettings — #893 top-level authMode promotion", () => {
  it("no vendor's default block carries an `authMode` field (promoted top-level)", () => {
    for (const v of LLM_VENDORS) {
      expect("authMode" in LLM_VENDOR_DEFAULTS[v]).toBe(false);
    }
  });

  it("freshVendorBlocks() returns mutable copies without authMode", () => {
    const blocks = freshVendorBlocks();
    for (const v of LLM_VENDORS) {
      expect("authMode" in blocks[v]).toBe(false);
    }
  });
});
