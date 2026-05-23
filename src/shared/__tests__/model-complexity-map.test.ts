import { describe, expect, it } from "vitest";
import {
  MODEL_COMPLEXITY_LEVELS,
  MODEL_COMPLEXITY_MAP,
  findOrphanedComplexityModels,
  isModelComplexityLevel,
  resolveModelForComplexity,
} from "../model-complexity-map.js";
import { LLM_VENDORS, type LLMVendor } from "../llm-vendor-defaults.js";

describe("model-complexity-map", () => {
  describe("MODEL_COMPLEXITY_MAP coverage", () => {
    it("declares every LLM vendor", () => {
      for (const vendor of LLM_VENDORS) {
        expect(
          MODEL_COMPLEXITY_MAP[vendor],
          `vendor "${vendor}" missing from MODEL_COMPLEXITY_MAP`,
        ).toBeDefined();
      }
    });

    it("declares every complexity tier per vendor", () => {
      for (const vendor of LLM_VENDORS) {
        for (const level of MODEL_COMPLEXITY_LEVELS) {
          const model = MODEL_COMPLEXITY_MAP[vendor][level];
          expect(
            typeof model,
            `${vendor}/${level} must be a string`,
          ).toBe("string");
          expect(model.length).toBeGreaterThan(0);
        }
      }
    });

    it("every (vendor, tier, model) triple appears in LLM_VENDOR_MODEL_OPTIONS", () => {
      const orphans = findOrphanedComplexityModels();
      expect(
        orphans,
        `complexity map references models the vendor catalog does not list: ${JSON.stringify(orphans, null, 2)}`,
      ).toEqual([]);
    });
  });

  describe("isModelComplexityLevel", () => {
    it("accepts the three tier strings", () => {
      expect(isModelComplexityLevel("low")).toBe(true);
      expect(isModelComplexityLevel("mid")).toBe(true);
      expect(isModelComplexityLevel("high")).toBe(true);
    });

    it("rejects vendor-specific model IDs (treated as explicit overrides)", () => {
      expect(isModelComplexityLevel("gpt-5.4-mini")).toBe(false);
      expect(isModelComplexityLevel("claude-sonnet-4-6")).toBe(false);
      expect(isModelComplexityLevel("gemini-2.5-pro")).toBe(false);
    });

    it("rejects non-string and empty values", () => {
      expect(isModelComplexityLevel(undefined)).toBe(false);
      expect(isModelComplexityLevel(null)).toBe(false);
      expect(isModelComplexityLevel("")).toBe(false);
      expect(isModelComplexityLevel(42)).toBe(false);
      expect(isModelComplexityLevel({})).toBe(false);
      // Adjacent-but-wrong strings: case-sensitive, no aliases.
      expect(isModelComplexityLevel("LOW")).toBe(false);
      expect(isModelComplexityLevel("medium")).toBe(false);
    });
  });

  describe("resolveModelForComplexity", () => {
    it("returns the mapped model for every (vendor, tier) pair", () => {
      for (const vendor of LLM_VENDORS) {
        for (const level of MODEL_COMPLEXITY_LEVELS) {
          const resolved = resolveModelForComplexity(vendor, level);
          expect(resolved).toBe(MODEL_COMPLEXITY_MAP[vendor][level]);
        }
      }
    });

    it("returns null when vendor is missing — caller falls back to parent model", () => {
      expect(resolveModelForComplexity(null, "mid")).toBeNull();
      expect(resolveModelForComplexity(undefined, "mid")).toBeNull();
    });

    it("returns null when level is missing — caller falls back to parent model", () => {
      expect(resolveModelForComplexity("claude", null)).toBeNull();
      expect(resolveModelForComplexity("claude", undefined)).toBeNull();
    });

    it("returns null for an unknown vendor (string passed through boundary)", () => {
      expect(
        resolveModelForComplexity("totally-fake-vendor" as LLMVendor, "mid"),
      ).toBeNull();
    });
  });

  describe("per-vendor sanity (concrete pinned tiers)", () => {
    // Anchor the picks so a future contributor who flips the catalog has
    // to come through here and re-justify the tier choice. These are the
    // tiers the staff-facing agent profiles depend on; cross-PR drift
    // would silently shift the user's sub-agent model.
    it("claude tiers: haiku=low, sonnet=mid, opus=high", () => {
      expect(MODEL_COMPLEXITY_MAP.claude).toEqual({
        low: "claude-haiku-4-5",
        mid: "claude-sonnet-4-6",
        high: "claude-opus-4-6",
      });
    });

    it("openai tiers: nano=low, mini=mid, full=high", () => {
      expect(MODEL_COMPLEXITY_MAP.openai).toEqual({
        low: "gpt-5.4-nano",
        mid: "gpt-5.4-mini",
        high: "gpt-5.4",
      });
    });

    it("gemini tiers: flash-lite=low, flash=mid, pro=high", () => {
      expect(MODEL_COMPLEXITY_MAP.gemini).toEqual({
        low: "gemini-2.5-flash-lite",
        mid: "gemini-2.5-flash",
        high: "gemini-2.5-pro",
      });
    });
  });
});
