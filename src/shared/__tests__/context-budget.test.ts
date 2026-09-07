import { describe, it, expect } from "vitest";
import {
  getUsableContext,
  getPreflightThreshold,
  resolveContextWindowForRoute,
  resolveModelContextWindow,
} from "../context-budget.js";
import { FALLBACK_PRICING } from "../pricing-data.js";
import { freshAllVendorBlocks } from "../llm-vendor-defaults.js";
import { llmModelListCacheKey, type LlmModelListCache } from "../llm-model-list.js";

describe("getUsableContext — LVIS tier-fixed reservations", () => {
  it("64K → 37K usable (27K reserved for output-heavy small models)", () => {
    expect(getUsableContext(64_000)).toBe(37_000);
  });

  it("128K → 98K usable (30K reserved)", () => {
    expect(getUsableContext(128_000)).toBe(98_000);
  });

  it("200K → 160K usable (40K reserved — Anthropic default tier)", () => {
    expect(getUsableContext(200_000)).toBe(160_000);
  });

  it("1M → 960K usable (40K floor wins over 0.8× = 800K)", () => {
    expect(getUsableContext(1_000_000)).toBe(960_000);
  });

  it("2M → 1.96M usable", () => {
    expect(getUsableContext(2_000_000)).toBe(1_960_000);
  });

  it("medium 1.05M (gpt-5.4) → 1.01M usable", () => {
    expect(getUsableContext(1_050_000)).toBe(1_010_000);
  });

  it("tiny window 32K → 25.6K (0.8× wins, avoids negative)", () => {
    expect(getUsableContext(32_000)).toBe(25_600);
  });

  it("threshold edge: 40K → 32K (0.8× exactly)", () => {
    expect(getUsableContext(40_000)).toBe(32_000);
  });

  it("invalid inputs return 0", () => {
    expect(getUsableContext(0)).toBe(0);
    expect(getUsableContext(-100)).toBe(0);
    expect(getUsableContext(NaN)).toBe(0);
    expect(getUsableContext(Infinity)).toBe(0);
  });

  it("usable is always strictly less than raw for positive ctx", () => {
    for (const ctx of [16_000, 64_000, 128_000, 200_000, 400_000, 1_000_000]) {
      expect(getUsableContext(ctx)).toBeLessThan(ctx);
      expect(getUsableContext(ctx)).toBeGreaterThan(0);
    }
  });
});

describe("getPreflightThreshold — token preflight trigger", () => {
  it("64K → floor(37K × 80%) = 29,600", () => {
    expect(getPreflightThreshold(64_000)).toBe(29_600);
  });

  it("128K → floor(98K × 80%) = 78,400", () => {
    expect(getPreflightThreshold(128_000)).toBe(78_400);
  });

  it("200K → floor(160K × 80%) = 128,000", () => {
    expect(getPreflightThreshold(200_000)).toBe(128_000);
  });

  it("1M → floor(960K × 80%) = 768,000", () => {
    expect(getPreflightThreshold(1_000_000)).toBe(768_000);
  });

  it("Other (>1M) → 80% of usable", () => {
    expect(getPreflightThreshold(2_000_000)).toBe(1_568_000);
  });

  it("Boundary <=64K (e.g. 32K small) → 80% of usable", () => {
    expect(getPreflightThreshold(32_000)).toBe(20_480);
  });

  it("invalid inputs return 0", () => {
    expect(getPreflightThreshold(0)).toBe(0);
    expect(getPreflightThreshold(-100)).toBe(0);
    expect(getPreflightThreshold(NaN)).toBe(0);
    expect(getPreflightThreshold(Infinity)).toBe(0);
  });

  it("threshold is always less than usable for positive ctx", () => {
    for (const ctx of [64_000, 128_000, 200_000, 1_000_000, 2_000_000]) {
      expect(getPreflightThreshold(ctx)).toBeLessThan(getUsableContext(ctx));
      expect(getPreflightThreshold(ctx)).toBeGreaterThan(0);
    }
  });

  it("threshold percentage is exactly 80% of usable", () => {
    for (const ctx of [64_000, 128_000, 200_000, 1_000_000, 2_000_000]) {
      const ratio = getPreflightThreshold(ctx) / getUsableContext(ctx);
      expect(ratio).toBe(0.8);
    }
  });
});

describe("resolveModelContextWindow — where the budget's denominator comes from", () => {
  it("takes the vendor block's declared window over everything else", () => {
    const resolved = resolveModelContextWindow({
      vendor: "claude",
      model: "claude-sonnet-4-5",
      configured: 300_000,
      reported: 229_376,
    });

    expect(resolved).toEqual({ contextWindow: 300_000, source: "vendor-setting" });
  });

  it("takes what the provider reported when nothing was declared", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "a-model-no-catalog-knows",
      reported: 229_376,
    });

    expect(resolved).toEqual({ contextWindow: 229_376, source: "provider-reported" });
  });

  it("reads the pricing catalog when neither input is present", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "Qwen3.6-35B-A3B-NVFP4",
    });

    expect(resolved).toEqual({ contextWindow: 262_144, source: "pricing-catalog" });
  });

  it("matches the catalog entry whatever case the served id is spelled in", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "qwen3.6-35b-a3b-nvfp4",
    });

    expect(resolved).toEqual({ contextWindow: 262_144, source: "pricing-catalog" });
  });

  it("names the fallback as a fallback so a caller can report the guess", () => {
    const resolved = resolveModelContextWindow({
      vendor: "openai-compatible",
      model: "a-model-no-catalog-knows",
    });

    expect(resolved).toEqual({
      contextWindow: FALLBACK_PRICING.contextWindow,
      source: "fallback",
    });
  });

  it("treats a malformed or non-positive declared window as not declared", () => {
    // A stored 0 that survived would zero the preflight threshold and switch
    // auto-compaction off for the route entirely.
    for (const configured of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveModelContextWindow({
          vendor: "openai-compatible",
          model: "a-model-no-catalog-knows",
          configured,
        }).source,
      ).toBe("fallback");
    }
  });

  it("treats a malformed provider-reported window as absent, not as an error", () => {
    expect(
      resolveModelContextWindow({
        vendor: "openai-compatible",
        model: "a-model-no-catalog-knows",
        reported: 0,
      }),
    ).toEqual({ contextWindow: FALLBACK_PRICING.contextWindow, source: "fallback" });
  });
});

describe("resolveContextWindowForRoute — one answer for the engine and the ring", () => {
  function routeSettings(overrides: {
    contextWindow?: number;
    reported?: { contextLength?: number; maxOutputTokens?: number };
    baseUrl?: string;
    presetId?: string;
  } = {}) {
    const model = "a-model-no-catalog-knows";
    const vendors = freshAllVendorBlocks();
    const block = vendors["openai-compatible"];
    block.baseUrl = overrides.baseUrl ?? "https://models.invalid/v1";
    if (overrides.presetId) block.presetModels = { [overrides.presetId]: model };
    else block.model = model;
    if (overrides.contextWindow !== undefined) block.contextWindow = overrides.contextWindow;
    const modelListCache: LlmModelListCache = {};
    if (overrides.reported) {
      const key = llmModelListCacheKey(
        "openai-compatible",
        overrides.baseUrl ?? "https://models.invalid/v1",
        overrides.presetId ?? "",
      );
      modelListCache[key] = {
        vendor: "openai-compatible",
        endpoint: "https://models.invalid/v1/models",
        models: [model],
        modelEntries: [{ id: model, ...overrides.reported }],
        fetchedAt: new Date(0).toISOString(),
      };
    }
    return {
      provider: "openai-compatible" as const,
      vendors,
      modelListCache,
      ...(overrides.presetId ? { marketplaceProviderPresetId: overrides.presetId } : {}),
    };
  }

  it("reads the window the vendor block declares, over the provider's report", () => {
    expect(
      resolveContextWindowForRoute(
        routeSettings({ contextWindow: 300_000, reported: { contextLength: 229_376 } }),
      ),
    ).toMatchObject({
      model: "a-model-no-catalog-knows",
      contextWindow: 300_000,
      source: "vendor-setting",
    });
  });

  it("reads what the route's own /models handshake reported for that model", () => {
    expect(
      resolveContextWindowForRoute(
        routeSettings({ reported: { contextLength: 229_376, maxOutputTokens: 32_768 } }),
      ),
    ).toMatchObject({
      contextWindow: 229_376,
      source: "provider-reported",
      maxOutputTokens: 32_768,
    });
  });

  it("looks the preset's row up under the preset's own endpoint", () => {
    // A preset is a provider in its own right reached through the
    // openai-compatible vendor: its catalogue synced against its own address,
    // so keying the lookup on the generic block's would find nothing.
    const settings = routeSettings({
      presetId: "provider-alpha",
      baseUrl: "https://preset.invalid/v1",
      reported: { contextLength: 131_072 },
    });

    expect(
      resolveContextWindowForRoute(settings, [
        { providerId: "provider-alpha", baseUrl: "https://preset.invalid/v1" },
      ]),
    ).toMatchObject({ contextWindow: 131_072, source: "provider-reported" });
  });

  it("moves to the next source when the route has no handshake for the model", () => {
    expect(resolveContextWindowForRoute(routeSettings())).toMatchObject({
      contextWindow: FALLBACK_PRICING.contextWindow,
      source: "fallback",
    });
  });
});
