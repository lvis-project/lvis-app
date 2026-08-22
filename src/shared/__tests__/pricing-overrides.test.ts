/**
 * Per-model price corrections — the shared parse/merge/precedence rules.
 *
 * The pair that matters most: the settings list and the deployed env blob are
 * two spellings of one thing, so a case proven for one has to hold for the
 * other. Anything that only held for one would be the second implementation
 * this module exists to prevent.
 */
import { describe, it, expect } from "vitest";
import {
  applyPricingOverride,
  normalizePricingOverrides,
  parsePricingOverrideEnv,
  pricingOverridesSignature,
  resolvePricingOverrides,
  isPricingOverrideRate,
} from "../pricing-overrides.js";
import { lookupPricing } from "../pricing-data.js";

const CLAUDE_SONNET = "claude-sonnet-4-6";

describe("normalizePricingOverrides", () => {
  it("keeps a complete row and trims its identifiers", () => {
    expect(normalizePricingOverrides([
      { vendor: " claude ", model: ` ${CLAUDE_SONNET} `, inputPer1M: 2, outputPer1M: 9 },
    ])).toEqual([{ vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 }]);
  });

  it("keeps zero, which is a rate a free internal endpoint can state", () => {
    expect(normalizePricingOverrides([
      { vendor: "openai-compatible", model: "local", inputPer1M: 0, outputPer1M: 0 },
    ])).toHaveLength(1);
  });

  it("drops only the malformed rows, never the whole list", () => {
    expect(normalizePricingOverrides([
      { vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 },
      { vendor: "claude", model: "", inputPer1M: 1, outputPer1M: 1 },
      { vendor: "openai", model: "gpt-4o", inputPer1M: -1, outputPer1M: 1 },
      { vendor: "openai", model: "gpt-4o", inputPer1M: "3" },
      "not a row",
    ])).toEqual([{ vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 }]);
  });

  it("lets a later row for the same model win, so a list can be appended to", () => {
    expect(normalizePricingOverrides([
      { vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 },
      { vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 1, outputPer1M: 4 },
    ])).toEqual([{ vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 1, outputPer1M: 4 }]);
  });

  it("carries the optional cache rates when they are present and valid", () => {
    expect(normalizePricingOverrides([
      {
        vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9,
        cacheReadPer1M: 0.2, cacheWritePer1M: "nope",
      },
    ])).toEqual([
      { vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9, cacheReadPer1M: 0.2 },
    ]);
  });

  it("answers an empty list for anything that is not a list", () => {
    expect(normalizePricingOverrides(undefined)).toEqual([]);
    expect(normalizePricingOverrides({ claude: {} })).toEqual([]);
  });
});

describe("parsePricingOverrideEnv", () => {
  it("flattens the deployed nested shape into the list shape", () => {
    expect(parsePricingOverrideEnv(JSON.stringify({
      claude: { [CLAUDE_SONNET]: { inputPer1M: 2, outputPer1M: 9, contextWindow: 200_000 } },
    }))).toEqual([{ vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 }]);
  });

  it("reports list price rather than zero cost when the blob does not parse", () => {
    expect(parsePricingOverrideEnv("{not json")).toEqual([]);
    expect(parsePricingOverrideEnv("[]")).toEqual([]);
    expect(parsePricingOverrideEnv("")).toEqual([]);
    expect(parsePricingOverrideEnv(undefined)).toEqual([]);
  });

  it("applies the same row validity rule the settings list gets", () => {
    expect(parsePricingOverrideEnv(JSON.stringify({
      claude: { [CLAUDE_SONNET]: { inputPer1M: 2 } },
      openai: "not an object",
    }))).toEqual([]);
  });
});

describe("resolvePricingOverrides", () => {
  const setting = [{ vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 1, outputPer1M: 4 }];

  it("uses the setting when the environment says nothing", () => {
    expect(resolvePricingOverrides(setting, {})).toEqual(setting);
    expect(resolvePricingOverrides(undefined, {})).toEqual([]);
  });

  it("lets the environment replace the whole list, not merge into it", () => {
    const resolved = resolvePricingOverrides(setting, {
      LVIS_PRICING_OVERRIDE: JSON.stringify({
        openai: { "gpt-4o": { inputPer1M: 5, outputPer1M: 15 } },
      }),
    });
    expect(resolved).toEqual([
      { vendor: "openai", model: "gpt-4o", inputPer1M: 5, outputPer1M: 15 },
    ]);
  });

  it("falls back to the setting when the variable is set but unusable", () => {
    expect(resolvePricingOverrides(setting, { LVIS_PRICING_OVERRIDE: "{oops" })).toEqual(setting);
  });
});

describe("applyPricingOverride", () => {
  it("merges the rates over the base rather than replacing the entry", () => {
    const base = lookupPricing("claude", CLAUDE_SONNET);
    const merged = applyPricingOverride("claude", CLAUDE_SONNET, [
      { vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 },
    ]);
    expect(merged.inputPer1M).toBe(2);
    expect(merged.outputPer1M).toBe(9);
    // The part a replacement would have destroyed.
    expect(merged.contextWindow).toBe(base.contextWindow);
    expect(merged.contextWindow1MBeta).toBe(base.contextWindow1MBeta);
  });

  it("returns the base untouched when nothing matches", () => {
    const base = lookupPricing("claude", CLAUDE_SONNET);
    expect(applyPricingOverride("claude", CLAUDE_SONNET, [])).toEqual(base);
    expect(applyPricingOverride("claude", CLAUDE_SONNET, [
      { vendor: "openai", model: "gpt-4o", inputPer1M: 1, outputPer1M: 1 },
    ])).toEqual(base);
  });

  it("matches the exact model id, not a prefix of it", () => {
    const overrides = [
      { vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 },
    ];
    expect(applyPricingOverride("claude", "claude-opus-4-6", overrides).inputPer1M)
      .toBe(lookupPricing("claude", "claude-opus-4-6").inputPer1M);
  });
});

describe("pricingOverridesSignature", () => {
  it("ignores row order, so a reorder does not invalidate the usage cache", () => {
    const a = [
      { vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 },
      { vendor: "openai", model: "gpt-4o", inputPer1M: 5, outputPer1M: 15 },
    ];
    expect(pricingOverridesSignature(a)).toBe(pricingOverridesSignature([...a].reverse()));
  });

  it("changes when a rate changes", () => {
    const a = [{ vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 2, outputPer1M: 9 }];
    const b = [{ vendor: "claude", model: CLAUDE_SONNET, inputPer1M: 3, outputPer1M: 9 }];
    expect(pricingOverridesSignature(a)).not.toBe(pricingOverridesSignature(b));
  });

  it("is empty-stable, so no correction means one cache key", () => {
    expect(pricingOverridesSignature([])).toBe(pricingOverridesSignature([]));
  });
});

describe("isPricingOverrideRate", () => {
  it("accepts a non-negative finite number and nothing else", () => {
    expect(isPricingOverrideRate(0)).toBe(true);
    expect(isPricingOverrideRate(1.25)).toBe(true);
    expect(isPricingOverrideRate(-1)).toBe(false);
    expect(isPricingOverrideRate(Number.NaN)).toBe(false);
    expect(isPricingOverrideRate(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPricingOverrideRate("2")).toBe(false);
  });
});
