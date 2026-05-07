/**
 * Shared pricing-data tests — ensure engine (pricing.ts) and the shared
 * module expose the same prices, and that the env-override path lives on
 * the engine side only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRICING,
  FALLBACK_PRICING,
  lookupPricing,
  lookupPricingOptional,
} from "../pricing-data.js";
import { getModelPricing, PRICING_TABLE } from "../../engine/llm/pricing.js";

describe("shared pricing-data", () => {
  it("engine and shared module expose the same default table", () => {
    // PRICING_TABLE is re-exported from the shared DEFAULT_PRICING — identity
    // equality guarantees the engine can't silently fork.
    expect(PRICING_TABLE).toBe(DEFAULT_PRICING);
  });

  it("shared + engine return the same prices for known models (no override)", () => {
    const prevOverride = process.env.LVIS_PRICING_OVERRIDE;
    delete process.env.LVIS_PRICING_OVERRIDE;
    try {
      const samples: Array<[string, string]> = [
        ["claude", "claude-sonnet-4-6"],
        ["claude", "claude-opus-4-6"],
        ["claude", "claude-haiku-4-5"],
        ["openai", "gpt-5.4"],
        ["openai", "gpt-5.4-mini"],
        ["openai", "gpt-4.1"],
        ["gemini", "gemini-2.5-flash"],
        ["copilot", "gpt-4.1"],
      ];
      for (const [vendor, model] of samples) {
        const fromShared = lookupPricing(vendor, model);
        const fromEngine = getModelPricing(vendor as any, model);
        expect(fromEngine).toEqual(fromShared);
      }
    } finally {
      if (prevOverride === undefined) delete process.env.LVIS_PRICING_OVERRIDE;
      else process.env.LVIS_PRICING_OVERRIDE = prevOverride;
    }
  });

  it("prefix fallback matches known model family", () => {
    // A suffix-dated variant should hit the prefix entry.
    const p = lookupPricing("claude", "claude-sonnet-4-6-20260214");
    expect(p.inputPer1M).toBe(3);
    expect(p.outputPer1M).toBe(15);
  });

  it("unknown vendor/model falls back to zero-cost FALLBACK_PRICING", () => {
    const p = lookupPricing("nope", "mystery-model");
    expect(p).toBe(FALLBACK_PRICING);
    expect(p.inputPer1M).toBe(0);
    expect(p.outputPer1M).toBe(0);
  });
});

describe("engine pricing env-override (Node-only layer)", () => {
  const prev = process.env.LVIS_PRICING_OVERRIDE;
  beforeEach(() => { delete process.env.LVIS_PRICING_OVERRIDE; });
  afterEach(() => {
    if (prev === undefined) delete process.env.LVIS_PRICING_OVERRIDE;
    else process.env.LVIS_PRICING_OVERRIDE = prev;
  });

  it("LVIS_PRICING_OVERRIDE replaces the matched entry", () => {
    process.env.LVIS_PRICING_OVERRIDE = JSON.stringify({
      claude: {
        "claude-sonnet-4-6": { inputPer1M: 99, outputPer1M: 199, contextWindow: 123 },
      },
    });
    const p = getModelPricing("claude", "claude-sonnet-4-6");
    expect(p.inputPer1M).toBe(99);
    expect(p.outputPer1M).toBe(199);
    expect(p.contextWindow).toBe(123);
  });

  it("shared lookupPricing ignores env overrides (stays pure)", () => {
    process.env.LVIS_PRICING_OVERRIDE = JSON.stringify({
      claude: {
        "claude-sonnet-4-6": { inputPer1M: 99, outputPer1M: 199, contextWindow: 123 },
      },
    });
    const p = lookupPricing("claude", "claude-sonnet-4-6");
    expect(p.inputPer1M).toBe(3);
    expect(p.outputPer1M).toBe(15);
  });

  it("malformed override JSON is ignored — default table wins", () => {
    process.env.LVIS_PRICING_OVERRIDE = "{not valid json";
    const p = getModelPricing("claude", "claude-sonnet-4-6");
    expect(p.inputPer1M).toBe(3);
  });

  it("lookupPricingOptional returns undefined on miss (strict variant)", () => {
    // Locks the contract that UI consumers use to disable cost-mode toggle:
    // unknown vendor/model → undefined (not FALLBACK_PRICING) so the badge
    // shows "no pricing available" instead of an inaccurate $0 estimate.
    expect(lookupPricingOptional("openai", "no-such-model-xyz")).toBeUndefined();
    expect(lookupPricingOptional("azure-foundry", "any-deployment")).toBeUndefined();
    // Known model still resolves
    expect(lookupPricingOptional("claude", "claude-sonnet-4-6")?.inputPer1M).toBe(3);
  });
});
