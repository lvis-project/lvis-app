import { describe, it, expect } from "vitest";
import {
  isLLMVendor,
  LLM_VENDORS,
  LLM_VENDOR_DEFAULTS,
  LLM_VENDOR_MODEL_OPTIONS,
  freshVendorBlocks,
  isRetiredLlmModel,
  normalizeLlmVendorModel,
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

describe("LLM vendor defaults", () => {
  it("keeps provider count in the Cline-scale range", () => {
    // Cline had 49 built-in provider IDs when this expansion was mirrored
    // (2026-06-29). LVIS intentionally skips subscription/CLI-only providers,
    // but keeps the OpenAI-compatible preset surface broad enough to be
    // comparable rather than a small handful of hardcoded vendors.
    expect(LLM_VENDORS.length).toBeGreaterThanOrEqual(40);
    expect(isLLMVendor("openrouter")).toBe(true);
    expect(isLLMVendor("ollama")).toBe(true);
    expect(isLLMVendor("lmstudio")).toBe(true);
  });

  it("uses gpt-5.4-mini as the OpenAI default model", () => {
    expect(LLM_VENDOR_DEFAULTS.openai.model).toBe("gpt-5.4-mini");
  });

  it("does not offer gpt-4o in user-selectable LLM model options", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_MODEL_OPTIONS[v]).not.toContain("gpt-4o");
      expect(LLM_VENDOR_DEFAULTS[v].model).not.toBe("gpt-4o");
    }
  });

  it("normalizes the retired exact gpt-4o model id to each provider default", () => {
    expect(isRetiredLlmModel("gpt-4o")).toBe(true);
    expect(isRetiredLlmModel("gpt-4o-mini")).toBe(false);
    expect(isRetiredLlmModel("gpt-4o-deployment")).toBe(false);
    expect(normalizeLlmVendorModel("openai", "gpt-4o")).toBe("gpt-5.4-mini");
    expect(normalizeLlmVendorModel("azure-foundry", "gpt-4o")).toBe("gpt-5.4-mini");
  });

  it("uses gemini-2.5-flash as the Gemini default model", () => {
    expect(LLM_VENDOR_DEFAULTS.gemini.model).toBe("gemini-2.5-flash");
  });

  it("enables thinking by default for every provider", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_DEFAULTS[v].enableThinking).toBe(true);
    }
  });

  it("freshVendorBlocks() preserves the default thinking-enabled blocks", () => {
    const blocks = freshVendorBlocks();
    expect(blocks.openai.model).toBe("gpt-5.4-mini");
    expect(blocks.gemini.model).toBe("gemini-2.5-flash");
    for (const v of LLM_VENDORS) {
      expect(blocks[v].enableThinking).toBe(true);
    }
  });

  it("includes each provider's default model in its dropdown options", () => {
    for (const v of LLM_VENDORS) {
      expect(LLM_VENDOR_MODEL_OPTIONS[v]).toContain(LLM_VENDOR_DEFAULTS[v].model);
    }
  });
});
