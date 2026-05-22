/**
 * Shared pricing-data tests — ensure engine (pricing.ts) and the shared
 * module expose the same prices, and that the env-override path lives on
 * the engine side only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeCost,
  DEFAULT_PRICING,
  FALLBACK_PRICING,
  lookupBillablePricingOptional,
  lookupPricing,
  lookupPricingOptional,
  normalizeAiSdkUsageForCost,
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
        ["claude", "claude-opus-4-5"],
        ["claude", "claude-haiku-4-5"],
        ["openai", "gpt-5.4"],
        ["openai", "gpt-5.4-mini"],
        ["azure-foundry", "gpt-5.4-mini"],
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

  it.each(["claude-opus-4-6", "claude-opus-4-5"] as const)(
    "pins %s current standard pricing",
    (model) => {
      // Anthropic official pricing, checked 2026-05-22:
      // Opus 4.5/4.6 = $5 input, $6.25 5m cache write, $0.50 cache hit, $25 output.
      const p = lookupPricing("claude", model);
      expect(p.inputPer1M).toBe(5);
      expect(p.outputPer1M).toBe(25);
      expect(p.cacheReadPer1M).toBeUndefined();
      expect(p.cacheWritePer1M).toBeUndefined();
      expect(
        computeCost(
          {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
          },
          p,
          "claude",
        ),
      ).toBeCloseTo(36.75, 5);
    },
  );

  it("unknown vendor/model falls back to zero-cost FALLBACK_PRICING", () => {
    const p = lookupPricing("nope", "mystery-model");
    expect(p).toBe(FALLBACK_PRICING);
    expect(p.inputPer1M).toBe(0);
    expect(p.outputPer1M).toBe(0);
  });

  it("does not expose zero-price placeholder rows as billable pricing", () => {
    expect(lookupPricingOptional("openai", "gpt-4o")).toMatchObject({
      inputPer1M: 0,
      outputPer1M: 0,
      contextWindow: 128_000,
    });
    expect(lookupBillablePricingOptional("openai", "gpt-4o")).toBeUndefined();
    expect(lookupBillablePricingOptional("openai", "gpt-5.4-mini")).toMatchObject({
      inputPer1M: 0.75,
      cacheReadPer1M: 0.075,
      outputPer1M: 4.5,
    });
    expect(lookupBillablePricingOptional("azure-foundry", "gpt-5.4-mini")).toBeUndefined();
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
    expect(lookupPricingOptional("azure-foundry", "gpt-5.4-mini")?.contextWindow).toBe(400_000);
    // Known model still resolves
    expect(lookupPricingOptional("claude", "claude-sonnet-4-6")?.inputPer1M).toBe(3);
  });

  // Regression lock — issue #900. Pre-fix values were stale (mini/nano
  // contextWindow registered as 1.05M while official is 400K; pricing
  // 2-6x off across the family). Pin exact values so a future drift is
  // caught at test time rather than via user-reported 429 errors. When
  // OpenAI revises the spec, update both the catalog and this test in
  // the same PR.
  describe("gpt-5.4 family — exact OpenAI spec pin (issue #900)", () => {
    it("gpt-5.4 (1M-class base)", () => {
      const p = lookupPricing("openai", "gpt-5.4");
      expect(p.inputPer1M).toBe(2.5);
      expect(p.cacheReadPer1M).toBe(0.25);
      expect(p.outputPer1M).toBe(15);
      expect(p.contextWindow).toBe(1_050_000);
    });
    it("gpt-5.4-mini (400K tier)", () => {
      const p = lookupPricing("openai", "gpt-5.4-mini");
      expect(p.inputPer1M).toBe(0.75);
      expect(p.cacheReadPer1M).toBe(0.075);
      expect(p.outputPer1M).toBe(4.5);
      expect(p.contextWindow).toBe(400_000);
    });
    it("gpt-5.4-nano (400K tier, cheapest)", () => {
      const p = lookupPricing("openai", "gpt-5.4-nano");
      expect(p.inputPer1M).toBe(0.2);
      expect(p.outputPer1M).toBe(1.25);
      expect(p.contextWindow).toBe(400_000);
    });
    it("gpt-5.4-pro (1.1M-class premium)", () => {
      const p = lookupPricing("openai", "gpt-5.4-pro");
      expect(p.inputPer1M).toBe(30);
      expect(p.outputPer1M).toBe(180);
      expect(p.contextWindow).toBe(1_100_000);
    });
    it("Copilot proxy gpt-5.4-mini contextWindow matches OpenAI spec (pricing 0 — subscription billing)", () => {
      const p = lookupPricing("copilot", "gpt-5.4-mini");
      expect(p.inputPer1M).toBe(0);
      expect(p.outputPer1M).toBe(0);
      expect(p.contextWindow).toBe(400_000);
    });
    it("Azure OpenAI deployment id gpt-5.4-mini inherits the OpenAI model spec", () => {
      const p = lookupPricing("azure-foundry", "gpt-5.4-mini");
      expect(p.inputPer1M).toBe(0.75);
      expect(p.cacheReadPer1M).toBe(0.075);
      expect(p.outputPer1M).toBe(4.5);
      expect(p.contextWindow).toBe(400_000);
      expect(lookupBillablePricingOptional("azure-foundry", "gpt-5.4-mini")).toBeUndefined();
    });
  });
});

// Long-context surcharge (issue #900). OpenAI 공식: gpt-5.4 / gpt-5.4-pro
// 의 1M-class window 는 input>272K 시 *flat full-session* — 모든 token 이
// input 2x + output 1.5x. tiered (272K 초과분만 multiplier) 가 아닌 cliff.
// Sources: developers.openai.com/api/docs/models/gpt-5.4, openai.com/api/pricing
describe("computeCost — long-context surcharge (issue #900)", () => {
  const gpt54 = lookupPricing("openai", "gpt-5.4");
  const gpt54mini = lookupPricing("openai", "gpt-5.4-mini");

  it("input == threshold (272_000) — surcharge NOT applied (> check, not >=)", () => {
    const cost = computeCost({ inputTokens: 272_000, outputTokens: 10_000 }, gpt54, "openai");
    // standard: 272_000/1M × $2.5 + 10_000/1M × $15 = $0.68 + $0.15 = $0.83
    expect(cost).toBeCloseTo(0.83, 5);
  });

  it("input == 272_001 — full session surcharge (input 2x + output 1.5x)", () => {
    const cost = computeCost({ inputTokens: 272_001, outputTokens: 10_000 }, gpt54, "openai");
    // 272_001/1M × ($2.5 × 2) + 10_000/1M × ($15 × 1.5) = $1.360005 + $0.225 = $1.585005
    expect(cost).toBeCloseTo(1.585005, 5);
  });

  it("input == 300_000, output 10_000 — exact USD per OpenAI flat-session model", () => {
    const cost = computeCost({ inputTokens: 300_000, outputTokens: 10_000 }, gpt54, "openai");
    // 300_000/1M × $5 + 10_000/1M × $22.5 = $1.5 + $0.225 = $1.725
    expect(cost).toBeCloseTo(1.725, 5);
  });

  it("vendor isolation — claude with same threshold value does NOT trigger surcharge", () => {
    // Construct a synthetic ModelPricing with surcharge fields but vendor=claude
    // — the openai branch is the ONLY one with surcharge logic.
    const synth = { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000,
      surchargeInputThreshold: 272_000, surchargeInputMultiplier: 2, surchargeOutputMultiplier: 1.5 };
    const cost = computeCost({ inputTokens: 300_000, outputTokens: 10_000 }, synth, "claude");
    // claude branch: no surcharge applied — standard rates only
    // 300_000/1M × $3 + 10_000/1M × $15 = $0.9 + $0.15 = $1.05
    expect(cost).toBeCloseTo(1.05, 5);
  });

  it("model WITHOUT surcharge fields (gpt-5.4-mini) — no multiplier even above 272K", () => {
    const cost = computeCost({ inputTokens: 350_000, outputTokens: 10_000 }, gpt54mini, "openai");
    // mini standard: 350_000/1M × $0.75 + 10_000/1M × $4.5 = $0.2625 + $0.045 = $0.3075
    expect(cost).toBeCloseTo(0.3075, 5);
  });
});

describe("normalizeAiSdkUsageForCost", () => {
  it("converts AI SDK total input to Claude fresh input before cost math", () => {
    const normalized = normalizeAiSdkUsageForCost(
      {
        inputTokens: 1_700_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 200_000,
      },
      "claude",
    );

    expect(normalized).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 200_000,
    });
  });

  it.each(["openai", "azure-foundry", "gemini", "vertex-ai", "copilot"] as const)(
    "keeps %s provider prompt tokens cache-inclusive",
    (vendor) => {
      const usage = {
        inputTokens: 1_700_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 200_000,
      };
      expect(normalizeAiSdkUsageForCost(usage, vendor)).toBe(usage);
    },
  );
});
