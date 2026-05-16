/**
 * Unit tests for reviewer-vendor-map.ts
 *
 * Verifies that REVIEWER_VENDOR_MAP and reviewerVendorFor() correctly
 * translate all supported UI-facing reviewer provider names to canonical
 * LLMVendor names used by the secret store.
 */
import { describe, it, expect } from "vitest";
import {
  REVIEWER_VENDOR_MAP,
  reviewerVendorFor,
} from "../reviewer/reviewer-vendor-map.js";

describe("REVIEWER_VENDOR_MAP", () => {
  it("openai → openai", () => {
    expect(REVIEWER_VENDOR_MAP["openai"]).toBe("openai");
  });

  it("anthropic → claude", () => {
    expect(REVIEWER_VENDOR_MAP["anthropic"]).toBe("claude");
  });

  it("google → gemini", () => {
    expect(REVIEWER_VENDOR_MAP["google"]).toBe("gemini");
  });

  it("foundry is NOT in the map (handled by dedicated adapter branch)", () => {
    expect(REVIEWER_VENDOR_MAP["foundry"]).toBeUndefined();
  });

  it("gcp-playground is NOT in the map (handled by dedicated adapter branch)", () => {
    expect(REVIEWER_VENDOR_MAP["gcp-playground"]).toBeUndefined();
  });
});

describe("reviewerVendorFor()", () => {
  it("openai → 'openai'", () => {
    expect(reviewerVendorFor("openai")).toBe("openai");
  });

  it("anthropic → 'claude'", () => {
    expect(reviewerVendorFor("anthropic")).toBe("claude");
  });

  it("google → 'gemini'", () => {
    expect(reviewerVendorFor("google")).toBe("gemini");
  });

  it("foundry → null (caller handles dedicated adapter branch)", () => {
    expect(reviewerVendorFor("foundry")).toBeNull();
  });

  it("gcp-playground → null (caller handles dedicated adapter branch)", () => {
    expect(reviewerVendorFor("gcp-playground")).toBeNull();
  });

  it("unknown provider → null", () => {
    expect(reviewerVendorFor("unknown-xyz")).toBeNull();
  });
});
