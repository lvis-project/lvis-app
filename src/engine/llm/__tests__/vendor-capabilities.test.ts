import { describe, it, expect } from "vitest";
import {
  providerPackageSupportsReviewerAdapter,
  supportsVision,
  vendorSupportsLengthContinuation,
} from "../vendor-capabilities.js";

describe("supportsVision", () => {
  it("claude-sonnet-4-6 supports vision", () => {
    expect(supportsVision("claude", "claude-sonnet-4-6")).toBe(true);
  });

  it("o1-mini does NOT support vision", () => {
    expect(supportsVision("openai", "o1-mini")).toBe(false);
  });

  it("o3-mini does NOT support vision", () => {
    expect(supportsVision("openai", "o3-mini")).toBe(false);
  });

  it("gemini-2.5-flash supports vision", () => {
    expect(supportsVision("gemini", "gemini-2.5-flash")).toBe(true);
  });

  it("gpt-5 supports vision", () => {
    expect(supportsVision("openai", "gpt-5.4")).toBe(true);
  });

  it("gpt-3.5-turbo does NOT support vision", () => {
    expect(supportsVision("openai", "gpt-3.5-turbo")).toBe(false);
  });

  it("gpt-4o supports vision", () => {
    expect(supportsVision("openai", "gpt-4o")).toBe(true);
  });

  it("claude-2 (legacy) does NOT support vision", () => {
    expect(supportsVision("claude", "claude-2.1")).toBe(false);
  });

  it("empty model name returns false", () => {
    expect(supportsVision("claude", "")).toBe(false);
  });

  it("copilot routing falls back by model name", () => {
    expect(supportsVision("copilot", "gpt-4.1")).toBe(true);
    expect(supportsVision("copilot", "gpt-3.5-turbo")).toBe(false);
  });
});

describe("vendorSupportsLengthContinuation", () => {
  it("lights up for the self-hosted vLLM class (native continue_final_message)", () => {
    expect(vendorSupportsLengthContinuation("openai-compatible")).toBe(true);
    expect(vendorSupportsLengthContinuation("ollama")).toBe(true);
    expect(vendorSupportsLengthContinuation("lmstudio")).toBe(true);
    expect(vendorSupportsLengthContinuation("litellm")).toBe(true);
  });

  it("is OFF for commercial gateways and non-self-hosted vendors", () => {
    // Commercial OpenAI-compatible gateways do not honor continue_final_message.
    expect(vendorSupportsLengthContinuation("openrouter")).toBe(false);
    expect(vendorSupportsLengthContinuation("groq")).toBe(false);
    expect(vendorSupportsLengthContinuation("together")).toBe(false);
    expect(vendorSupportsLengthContinuation("openai")).toBe(false);
    expect(vendorSupportsLengthContinuation("claude")).toBe(false);
    expect(vendorSupportsLengthContinuation("gemini")).toBe(false);
  });
});

describe("providerPackageSupportsReviewerAdapter", () => {
  it("requires explicit package metadata opt-in", () => {
    expect(providerPackageSupportsReviewerAdapter(undefined)).toBe(false);
    expect(providerPackageSupportsReviewerAdapter({ capabilities: {} })).toBe(false);
    expect(providerPackageSupportsReviewerAdapter({
      capabilities: { reviewerAdapter: false },
    })).toBe(false);
    expect(providerPackageSupportsReviewerAdapter({
      capabilities: { reviewerAdapter: true },
    })).toBe(true);
  });
});
