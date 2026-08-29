import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const auditStatGate = vi.hoisted(() => ({
  target: undefined as string | undefined,
  append: undefined as (() => void) | undefined,
  appendBeforeStatOnCall: undefined as number | undefined,
  appendAfterStatOnCall: undefined as number | undefined,
  calls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const isTarget = auditStatGate.target && String(args[0]) === auditStatGate.target;
      if (isTarget) {
        auditStatGate.calls += 1;
        if (auditStatGate.calls === auditStatGate.appendBeforeStatOnCall) {
          auditStatGate.append?.();
        }
      }
      const metadata = await actual.stat(...args);
      if (isTarget && auditStatGate.calls === auditStatGate.appendAfterStatOnCall) {
        auditStatGate.append?.();
      }
      return metadata;
    },
  };
});

import {
  computeUsageSummary,
  readAuditEntries,
  computeMonthlyProjection,
  getUsageRange,
  getUsageSummary,
  createUsageSummaryCache,
  type AuditTurnEntry,
  type UsageTrendPoint,
} from "../usage-stats.js";
import { getModelPricing, computeCost } from "../llm/pricing.js";
import { resolvePricingOverrides } from "../../shared/pricing-overrides.js";

function turn(partial: Partial<AuditTurnEntry>): AuditTurnEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "s1",
    type: "turn",
    route: "claude/claude-sonnet-4-6",
    tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    ...partial,
  };
}

function summaryWithInput(inputTokens = 100): ReturnType<typeof computeUsageSummary> {
  return computeUsageSummary([
    turn({
      timestamp: "2026-07-04T01:00:00Z",
      tokenUsage: { inputTokens, outputTokens: 10 },
    }),
  ], new Date("2026-07-04T12:00:00Z"));
}

describe("UsageSummaryCache", () => {
  it("reuses a stable revision and returns isolated summaries", async () => {
    const cache = createUsageSummaryCache({ maxEntries: 2 });
    const compute = vi.fn(async () => ({
      summary: summaryWithInput(),
      cacheable: true,
    }));
    const first = await cache.getOrCompute({
      key: "stable",
      now: new Date("2026-07-04T12:00:00Z"),
      compute,
    });
    first.today.inputTokens = 999_999;
    first.trend[0].inputTokens = 999_999;
    first.subscription.sources["provider-reported"].totalTokens = 999_999;

    const secondNow = new Date("2026-07-04T12:01:00Z");
    const second = await cache.getOrCompute({
      key: "stable",
      now: secondNow,
      compute,
    });

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second.today.inputTokens).toBe(100);
    expect(second.trend[0].inputTokens).toBe(100);
    expect(second.subscription.sources["provider-reported"].totalTokens).toBe(0);
    expect(second.generatedAt).toBe(secondNow.toISOString());
  });

  it("does not retain an unstable snapshot", async () => {
    const cache = createUsageSummaryCache();
    const compute = vi.fn(async () => ({
      summary: summaryWithInput(),
      cacheable: false,
    }));

    await cache.getOrCompute({
      key: "unstable",
      now: new Date("2026-07-04T12:00:00Z"),
      compute,
    });
    await cache.getOrCompute({
      key: "unstable",
      now: new Date("2026-07-04T12:01:00Z"),
      compute,
    });

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used stable revision", async () => {
    const cache = createUsageSummaryCache({ maxEntries: 2 });
    const a = vi.fn(async () => ({ summary: summaryWithInput(100), cacheable: true }));
    const b = vi.fn(async () => ({ summary: summaryWithInput(200), cacheable: true }));
    const c = vi.fn(async () => ({ summary: summaryWithInput(300), cacheable: true }));
    const get = (key: string, compute: () => Promise<{ summary: ReturnType<typeof summaryWithInput>; cacheable: boolean }>) => (
      cache.getOrCompute({
        key,
        now: new Date("2026-07-04T12:00:00Z"),
        compute,
      })
    );

    await get("a", a);
    await get("b", b);
    await get("a", a);
    await get("c", c);
    await get("a", a);
    await get("b", b);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(c).toHaveBeenCalledTimes(1);
  });
});

describe("usage-stats", () => {
  // Every bucket boundary below is the HOST's midnight now, so the fixture
  // instants only mean what their comments say once the zone is pinned. Node
  // re-reads `TZ` on assignment. Seoul is what these fixtures were written
  // against; nothing in the code knows the name.
  let previousTz: string | undefined;
  beforeEach(() => {
    previousTz = process.env.TZ;
    process.env.TZ = "Asia/Seoul";
  });
  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("aggregates today/week/month totals from turn entries", () => {
    const now = new Date("2026-04-18T12:00:00Z"); // Saturday
    const entries: AuditTurnEntry[] = [
      turn({ timestamp: "2026-04-18T10:00:00Z", tokenUsage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      }),
      // Monday of same week
      turn({ timestamp: "2026-04-13T10:00:00Z", tokenUsage: { inputTokens: 200_000, outputTokens: 100_000 },
      }),
      // Earlier in month
      turn({ timestamp: "2026-04-02T10:00:00Z", tokenUsage: { inputTokens: 50_000, outputTokens: 25_000 },
      }),
      // Previous month — should only count toward trend, not today/week/month
      turn({ timestamp: "2026-03-15T10:00:00Z", tokenUsage: { inputTokens: 10_000, outputTokens: 5_000 },
      }),
    ];

    const summary = computeUsageSummary(entries, now);
    expect(summary.today.inputTokens).toBe(1_000_000);
    expect(summary.today.outputTokens).toBe(500_000);
    expect(summary.thisWeek.inputTokens).toBe(1_200_000);
    expect(summary.thisMonth.inputTokens).toBe(1_250_000);
  });

  it("keeps subscription telemetry separate from API price summaries", () => {
    const now = new Date("2026-07-04T12:00:00Z");
    const summary = computeUsageSummary([
      {
        timestamp: "2026-07-04T01:00:00Z",
        sessionId: "mixed-runtime-turn",
        type: "turn",
        route: "openai/gpt-4.1",
        tokenUsage: { inputTokens: 1_000, outputTokens: 500 },
        subscriptionUsage: [
          {
            provider: "codex",
            model: "gpt-5.4",
            source: "provider-reported",
            billable: false,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 4,
            reasoningOutputTokens: 10,
            totalTokens: 164,
          },
          {
            provider: "kimi-code",
            model: "default",
            source: "local-estimate",
            billable: false,
            inputTokens: 40,
            outputTokens: 5,
            totalTokens: 45,
          },
          // The normalizer rejects raw/expanded provider payloads at the
          // persisted-data boundary instead of letting them pollute totals.
          {
            provider: "codex",
            model: "gpt-5.4",
            source: "provider-reported",
            billable: false,
            inputTokens: 999,
            outputTokens: 999,
            totalTokens: 1_998,
            rawProviderPayload: { shouldNotReachRenderer: true },
          },
        ],
      },
    ], now);

    // API-key totals and pricing keep their original scope.
    expect(summary.today.totalTokens).toBe(1_500);
    expect(summary.perVendor.map((row) => row.vendor)).toEqual(["openai"]);
    expect(summary.perModel.map((row) => row.model)).toEqual(["gpt-4.1"]);

    // Subscription values stay in the token-only sibling summary.
    expect(summary.subscription.today).toMatchObject({
      inputTokens: 140,
      outputTokens: 25,
      cacheReadTokens: 30,
      cacheWriteTokens: 4,
      reasoningOutputTokens: 10,
      totalTokens: 209,
      segments: 2,
    });
    expect(summary.subscription.sources["provider-reported"]).toMatchObject({
      totalTokens: 164,
      segments: 1,
    });
    expect(summary.subscription.sources["local-estimate"]).toMatchObject({
      totalTokens: 45,
      segments: 1,
    });
    expect(summary.subscription.perRuntime).toEqual([
      expect.objectContaining({ provider: "codex", model: "*", totalTokens: 164 }),
      expect.objectContaining({ provider: "kimi-code", model: "*", totalTokens: 45 }),
    ]);
    expect(summary.subscription.perModel).toEqual([
      expect.objectContaining({ provider: "codex", model: "gpt-5.4", totalTokens: 164 }),
      expect.objectContaining({ provider: "kimi-code", model: "default", totalTokens: 45 }),
    ]);
    expect(summary.subscription.trend).toEqual([
      expect.objectContaining({ date: "2026-07-04", totalTokens: 209 }),
    ]);
  });

  it("buckets today and the trend on the host's calendar day, not UTC's", () => {
    const now = new Date("2026-07-03T16:00:00Z"); // 2026-07-04 01:00 in Seoul
    const entries: AuditTurnEntry[] = [
      turn({ timestamp: "2026-07-03T15:30:00Z", tokenUsage: { inputTokens: 100, outputTokens: 10 },
      }),
      turn({ timestamp: "2026-07-03T14:30:00Z", tokenUsage: { inputTokens: 300, outputTokens: 30 },
      }),
    ];

    const summary = computeUsageSummary(entries, now);
    expect(summary.today.inputTokens).toBe(100);
    expect(summary.trend.map((point) => [point.date, point.inputTokens]),
    ).toEqual([
      ["2026-07-03", 300],
      ["2026-07-04", 100],
    ]);
  });

  it("computes cost using pricing table — Claude Sonnet $3/$15 per 1M", () => {
    const entries = [turn({ tokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }),
    ];
    const summary = computeUsageSummary(entries, new Date());
    // $3 input + $15 output = $18
    expect(summary.perVendor[0].cost).toBeCloseTo(18, 5);
    expect(summary.perVendor[0].vendor).toBe("claude");
  });

  it("groups by model and session, ranks topConversations by cost", () => {
    const entries: AuditTurnEntry[] = [
      turn({ sessionId: "expensive", tokenUsage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
      }),
      turn({ sessionId: "cheap", tokenUsage: { inputTokens: 1000, outputTokens: 500 },
      }),
      turn({ sessionId: "expensive", tokenUsage: { inputTokens: 500_000, outputTokens: 200_000 },
      }),
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.topConversations[0].sessionId).toBe("expensive");
    expect(summary.topConversations[0].turns).toBe(2);
    expect(summary.perModel[0].model).toBe("claude-sonnet-4-6");
  });

  it("respects env pricing override", () => {
    // `getModelPricing` no longer reads the environment for itself — the
    // resolver decides between the setting and the variable, and the caller
    // that caches on the answer hands it in. The claim under test is the same:
    // an env blob makes the reported price the corrected one.
    const overrides = resolvePricingOverrides(undefined, {
      LVIS_PRICING_OVERRIDE: JSON.stringify({
        claude: {
          "claude-sonnet-4-6": {
            inputPer1M: 100,
            outputPer1M: 100,
            contextWindow: 1_000_000,
          },
        },
      }),
    });
    const p = getModelPricing("claude", "claude-sonnet-4-6", overrides);
    expect(p.inputPer1M).toBe(100);
    // The context window survives, because the override merges over the base
    // instead of replacing it — the old path only kept it if the blob restated it.
    expect(p.contextWindow).toBe(200_000);
    expect(
      computeCost(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        p,
        "claude",
      ),
    ).toBeCloseTo(200, 5);
  });

  describe("computeCost — vendor branch coverage", () => {
    const sonnet = { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 };
    const gpt = { inputPer1M: 2, outputPer1M: 8, contextWindow: 1_000_000 };

    it("claude — fresh + cache.read × 0.1 + cache.write × 1.25 + output (ratio fallback)", () => {
      // 1M fresh + 1M cacheRead + 1M cacheWrite + 1M output
      // 1*$3 + 1*$0.30 + 1*$3.75 + 1*$15 = $22.05
      expect(
        computeCost(
          {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
          },
          sonnet,
          "claude",
        ),
      ).toBeCloseTo(22.05, 5);
    });

    it("claude — explicit cacheReadPer1M / cacheWritePer1M override the ratio fallback", () => {
      const explicit = { ...sonnet, cacheReadPer1M: 0.5, cacheWritePer1M: 6 };
      // 1M fresh + 1M cacheRead + 1M cacheWrite + 1M output
      // 1*$3 + 1*$0.50 + 1*$6 + 1*$15 = $24.50
      expect(
        computeCost(
          {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 1_000_000,
          },
          explicit,
          "claude",
        ),
      ).toBeCloseTo(24.5, 5);
    });

    it.each(["openai", "copilot", "azure-foundry"] as const)(
      "%s — cache fields split prompt_tokens into fresh + discounted cached input",
      (vendor) => {
        // 1M prompt input contains 0.25M cached input. Cost is:
        // 0.75M*$2 fresh + 0.25M*$0.20 cached + 1M*$8 output = $9.55.
        expect(
          computeCost(
            {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 250_000,
              cacheWriteTokens: 0,
            },
            { ...gpt, cacheReadPer1M: 0.2 },
            vendor,
          ),
        ).toBeCloseTo(9.55, 5);
      },
    );

    it.each(["openai", "copilot", "azure-foundry"] as const)(
      "%s — missing cached-input rate treats cached prompt tokens as ordinary input",
      (vendor) => {
        expect(
          computeCost(
            {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 250_000,
            },
            gpt,
            vendor,
          ),
        ).toBeCloseTo(10, 5);
      },
    );

    it.each(["gemini", "vertex-ai"] as const)(
      "%s — cache fields ignored, write deferred to storage-per-hour cron",
      (vendor) => {
        const flash = { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000,
        };
        // Free tier: $0 regardless of cache.
        expect(
          computeCost(
            {
              inputTokens: 1_000_000,
              outputTokens: 1_000_000,
              cacheReadTokens: 1_000_000,
              cacheWriteTokens: 1_000_000,
            },
            flash,
            vendor,
          ),
        ).toBe(0);
      },
    );

    it("NaN / undefined / negative tokens all clamp to 0 (no negative cost)", () => {
      const result = computeCost(
        {
          inputTokens: NaN as unknown as number,
          outputTokens: -100,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        sonnet,
        "claude",
      );
      // Negatives clamp to 0 — usage is monotonic; malformed upstream data
      // must not produce sub-zero billing.
      expect(result).toBe(0);
    });
  });

  it("totalTokens vendor-aware — OpenAI cacheRead is NOT double-counted", () => {
    // For OpenAI, Vercel SDK's `cachedInputTokens` is already inside
    // `inputTokens`. If totalTokens added cacheRead again, the dashboard
    // would inflate by ~10% on cache-hot conversations.
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "openai-cache-hot",
        type: "turn",
        route: "openai/gpt-4.1",
        tokenUsage: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 500_000, // already inside inputTokens for OpenAI
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    // OpenAI: total = input + output = 1_100_000 (cache NOT added)
    expect(summary.perVendor[0].totalTokens).toBe(1_100_000);
  });

  it("marks zero-price placeholder model costs as unknown instead of fake $0", () => {
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "legacy-openai",
        type: "turn",
        route: "openai/gpt-4o",
        tokenUsage: {
          inputTokens: 10_000,
          outputTokens: 1_000,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].cost).toBe(0);
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
    expect(summary.today.unknownCostTurns).toBe(1);
  });

  it("marks Azure Foundry model-name inherited pricing as unknown without an explicit override", () => {
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "azure-model-alias",
        type: "turn",
        route: "azure-foundry/gpt-5.4-mini",
        tokenUsage: {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 5_000,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].vendor).toBe("azure-foundry");
    expect(summary.perVendor[0].cost).toBe(0);
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
  });

  it("keeps token-bearing bare legacy routes in an explicit unknown bucket", () => {
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "legacy-bare-route",
        type: "turn",
        route: "legacy",
        tokenUsage: {
          inputTokens: 10_000,
          outputTokens: 1_000,
          cacheReadTokens: 500,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].vendor).toBe("unknown");
    expect(summary.perVendor[0].model).toBe("*");
    expect(summary.perModel[0].vendor).toBe("unknown");
    expect(summary.perModel[0].model).toBe("legacy");
    expect(summary.perVendor[0].unknownCostTurns).toBe(1);
    expect(summary.perVendor[0].totalTokens).toBe(11_000);
  });

  it("uses per-model audit breakdown for mixed-provider fallback turns", () => {
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "mixed-fallback",
        type: "turn",
        route: "openai/gpt-5.4-mini",
        tokenUsage: {
          inputTokens: 2_010_000,
          outputTokens: 101_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
        usageByModel: [
          {
            vendorProvider: "claude",
            vendorModel: "claude-sonnet-4-6",
            tokenUsage: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              cacheReadTokens: 500_000,
              cacheWriteTokens: 200_000,
            },
          },
          {
            vendorProvider: "openai",
            vendorModel: "gpt-5.4-mini",
            tokenUsage: {
              inputTokens: 10_000,
              outputTokens: 1_000,
            },
          },
        ],
      },
    ];

    const summary = computeUsageSummary(entries, new Date());
    expect(summary.topConversations[0].turns).toBe(1);
    expect(summary.perVendor.map((row) => row.vendor).sort()).toEqual(["claude", "openai",
    ]);
    expect(summary.perModel.map((row) => `${row.vendor}/${row.model}`).sort(),
    ).toEqual(["claude/claude-sonnet-4-6", "openai/gpt-5.4-mini"]);
    expect(
      summary.perVendor.find((row) => row.vendor === "claude")?.totalTokens,
    ).toBe(1_800_000);
    expect(
      summary.perVendor.find((row) => row.vendor === "openai")?.totalTokens,
    ).toBe(11_000);
  });

  it("prices OpenAI long-context surcharge per provider request segment, not per LVIS turn aggregate", () => {
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "multi-round-openai",
        type: "turn",
        route: "openai/gpt-5.4",
        tokenUsage: {
          inputTokens: 400_000,
          outputTokens: 0,
        },
        usageByModel: [
          {
            vendorProvider: "openai",
            vendorModel: "gpt-5.4",
            tokenUsage: { inputTokens: 200_000, outputTokens: 0 },
          },
          {
            vendorProvider: "openai",
            vendorModel: "gpt-5.4",
            tokenUsage: { inputTokens: 200_000, outputTokens: 0 },
          },
        ],
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    // Each provider request is below the >272K surcharge threshold:
    // 2 * (200K * $2.50/M) = $1. Aggregating first would incorrectly
    // surcharge 400K at $5/M = $2.
    expect(summary.perModel[0].cost).toBeCloseTo(1, 5);
  });

  it("totalTokens vendor-aware — current Anthropic usageByModel adds cache to total", () => {
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "claude-cache-hot",
        type: "turn",
        route: "claude/claude-sonnet-4-6",
        tokenUsage: {
          inputTokens: 1_700_000,
          outputTokens: 100_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
        usageByModel: [
          {
            vendorProvider: "claude",
            vendorModel: "claude-sonnet-4-6",
            tokenUsage: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              cacheReadTokens: 500_000,
              cacheWriteTokens: 200_000,
            },
          },
        ],
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    // Claude: total = input + output + cacheRead + cacheWrite = 1_800_000
    expect(summary.perVendor[0].totalTokens).toBe(1_800_000);
    // Cost = fresh $3 + cache read $0.15 + cache write $0.75 + output $1.50.
    expect(summary.perVendor[0].cost).toBeCloseTo(5.4, 5);
  });

  it("normalizes legacy Claude audit rows without usageByModel before aggregation", () => {
    const entries: AuditTurnEntry[] = [
      {
        timestamp: new Date().toISOString(),
        sessionId: "legacy-claude-cache-hot",
        type: "turn",
        route: "claude/claude-sonnet-4-6",
        tokenUsage: {
          inputTokens: 1_700_000,
          outputTokens: 100_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
      },
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.perVendor[0].inputTokens).toBe(1_000_000);
    expect(summary.perVendor[0].totalTokens).toBe(1_800_000);
    expect(summary.perVendor[0].cost).toBeCloseTo(5.4, 5);
  });

  it("Anthropic billing-contract: cache reduces total cost vs uncached input", () => {
    // Same total token volume, but as 1M cache-read vs 1M fresh-input.
    // Anthropic cache-read at 0.1× input: cache turn must be 10× cheaper
    // on the input side. Locks the contract that audit/usage stats report
    // matches Anthropic's own billing breakdown.
    const sonnet = { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 };
    const cached = computeCost(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      },
      sonnet,
      "claude",
    );
    const fresh = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      sonnet,
      "claude",
    );
    expect(cached).toBeCloseTo(0.3, 5);
    expect(fresh).toBeCloseTo(3.0, 5);
    expect(cached / fresh).toBeCloseTo(0.1, 5);
  });

  it("OpenAI billing-contract: cached input is discounted without changing total token volume", () => {
    const gpt54mini = getModelPricing("openai", "gpt-5.4-mini");
    const cached = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000 },
      gpt54mini,
      "openai",
    );
    const fresh = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      gpt54mini,
      "openai",
    );
    // 100K fresh at $0.75/M + 900K cached at $0.075/M.
    expect(cached).toBeCloseTo(0.1425, 5);
    expect(fresh).toBeCloseTo(0.75, 5);
    expect(cached).toBeLessThan(fresh);
  });

  it("builds a chronological trend array", () => {
    const entries: AuditTurnEntry[] = [
      turn({ timestamp: "2026-04-10T10:00:00Z" }),
      turn({ timestamp: "2026-04-12T10:00:00Z" }),
      turn({ timestamp: "2026-04-11T10:00:00Z" }),
    ];
    const summary = computeUsageSummary(
      entries,
      new Date("2026-04-12T12:00:00Z"),
    );
    expect(summary.trend.map((t) => t.date)).toEqual([
      "2026-04-10",
      "2026-04-11",
      "2026-04-12",
    ]);
  });

  it("reads JSONL audit files and ignores non-turn entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-stats-"));
    try {
      mkdirSync(dir, { recursive: true });
      // Use a fixture date pinned to "yesterday" so the test stays inside
      // the 30-day lookback regardless of when CI runs. A hardcoded date
      // (e.g. "2026-04-18") silently ages out once wall-clock drifts past
      // the lookback window — the exact regression the previous fixture
      // hit on 2026-05-19 (1 day past the 30-day cap).
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const yyyy = yesterday.getUTCFullYear();
      const mm = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(yesterday.getUTCDate()).padStart(2, "0");
      const dateStr = `${yyyy}-${mm}-${dd}`;
      const file = join(dir, `${dateStr}.jsonl`);
      writeFileSync(
        file,
        [
          JSON.stringify(turn({ timestamp: `${dateStr}T10:00:00Z` })),
          JSON.stringify({
            type: "tool_call",
            timestamp: `${dateStr}T10:05:00Z`,
          }),
          "not json",
          "",
          JSON.stringify(turn({ timestamp: `${dateStr}T11:00:00Z` })),
        ].join("\n") + "\n",
        "utf-8",
      );
      const read = await readAuditEntries(dir, 365);
      expect(read.length).toBe(2);
      expect(read.every((e) => e.type === "turn")).toBe(true);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
  it("reads canonical gzip archives and excludes non-telemetry channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-gzip-"));
    const now = new Date("2026-07-04T12:00:00Z");
    try {
      const archivedTurn = turn({
        timestamp: "2026-07-03T15:30:00Z",
        sessionId: "archived",
        input: "archived input",
        tokenUsage: { inputTokens: 100, outputTokens: 10 },
      });
      const rawTurn = turn({
        timestamp: "2026-07-04T01:00:00Z",
        sessionId: "raw",
        tokenUsage: { inputTokens: 200, outputTokens: 20 },
      });
      writeFileSync(
        join(dir, "2026-07-03.jsonl.20260704120000000.11111111-1111-4111-8111-111111111111.gz"),
        gzipSync(Buffer.from(`${JSON.stringify(archivedTurn)}\n`, "utf-8")),
      );
      writeFileSync(join(dir, "2026-07-04.jsonl"), `${JSON.stringify(rawTurn)}\n`, "utf-8");
      writeFileSync(
        join(dir, "2026-07-03.permission-shadow.jsonl.20260704.gz"),
        gzipSync(Buffer.from(`${JSON.stringify(turn({ tokenUsage: { inputTokens: 9_999, outputTokens: 0 } }))}\n`, "utf-8")),
      );

      const entries = await readAuditEntries(dir, 2, now);
      expect(entries.map((entry) => entry.sessionId)).toEqual(["archived", "raw"]);
      expect(computeUsageSummary(entries, now).today.inputTokens).toBe(300);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("skips an entire corrupted gzip archive without losing valid files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-gzip-corrupt-"));
    const now = new Date("2026-07-04T12:00:00Z");
    try {
      const partialArchive = gzipSync(Buffer.from([
        JSON.stringify(turn({ sessionId: "should-not-count", timestamp: "2026-07-03T15:30:00Z" })),
        JSON.stringify(turn({ sessionId: "also-should-not-count", timestamp: "2026-07-03T15:31:00Z" })),
      ].join("\n") + "\n", "utf-8")).subarray(0, -8);
      writeFileSync(join(dir, "2026-07-03.jsonl.20260704.gz"), partialArchive);
      writeFileSync(
        join(dir, "2026-07-04.jsonl"),
        `${JSON.stringify(turn({ sessionId: "valid", timestamp: "2026-07-04T01:00:00Z" }))}\n`,
        "utf-8",
      );

      const entries = await readAuditEntries(dir, 2, now);
      expect(entries.map((entry) => entry.sessionId)).toEqual(["valid"]);
    } finally {
      await cleanupTmpDir(dir);
    }
  });
});

describe("computeMonthlyProjection", () => {
  it("returns 0 for empty trend", () => {
    expect(computeMonthlyProjection([])).toBe(0);
  });

  it("projects avg-per-day × 30", () => {
    const trend: UsageTrendPoint[] = [
      {
        date: "2026-04-01",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 1.0,
      },
      {
        date: "2026-04-02",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 3.0,
      },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(60, 5);
  });

  it("projects correctly for a single day", () => {
    const trend: UsageTrendPoint[] = [
      {
        date: "2026-04-01",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0.5,
      },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(15, 5);
  });
});

describe("getUsageRange (via readAuditEntries + filter)", () => {
  it("filters entries to exact date range", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-range-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "2026-04-10.jsonl"),
        JSON.stringify({
          timestamp: "2026-04-10T10:00:00Z",
          sessionId: "s1",
          type: "turn",
          route: "claude/claude-sonnet-4-6",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
        }) + "\n",
        "utf-8",
      );
      writeFileSync(
        join(dir, "2026-04-15.jsonl"),
        JSON.stringify({
          timestamp: "2026-04-15T10:00:00Z",
          sessionId: "s1",
          type: "turn",
          route: "claude/claude-sonnet-4-6",
          tokenUsage: { inputTokens: 200, outputTokens: 100 },
        }) + "\n",
        "utf-8",
      );
      writeFileSync(
        join(dir, "2026-04-20.jsonl"),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          sessionId: "s1",
          type: "turn",
          route: "claude/claude-sonnet-4-6",
          tokenUsage: { inputTokens: 400, outputTokens: 200 },
        }) + "\n",
        "utf-8",
      );

      const entries = (await readAuditEntries(dir, 365)).filter((e) => {
        const d = e.timestamp.slice(0, 10);
        return d >= "2026-04-10" && d <= "2026-04-15";
      });
      const summary = computeUsageSummary(entries);
      expect(summary.trend.map((t) => t.date)).toEqual([
        "2026-04-10",
        "2026-04-15",
      ]);
      expect(summary.trend[0].inputTokens).toBe(100);
      expect(summary.trend[1].inputTokens).toBe(200);
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("reads adjacent UTC gzip archives for a selected local day", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-range-kst-home-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "2026-07-03.jsonl.20260704.gz"),
        gzipSync(Buffer.from([
          JSON.stringify({
            timestamp: "2026-07-03T14:30:00Z",
            sessionId: "s1",
            type: "turn",
            route: "claude/claude-sonnet-4-6",
            tokenUsage: { inputTokens: 300, outputTokens: 30 },
          }),
          JSON.stringify({
            timestamp: "2026-07-03T15:30:00Z",
            sessionId: "s1",
            type: "turn",
            route: "claude/claude-sonnet-4-6",
            tokenUsage: { inputTokens: 100, outputTokens: 10 },
          }),
        ].join("\n") + "\n", "utf-8")),
      );

      const summary = await getUsageRange({
        dateFrom: "2026-07-04",
        dateTo: "2026-07-04",
      });
      expect(summary.trend.map((point) => point.date)).toEqual(["2026-07-04"]);
      expect(summary.trend[0].inputTokens).toBe(100);
    } finally {
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      await cleanupTmpDir(home);
    }
  });
});

describe("usage summary cache wiring", () => {
  it("invalidates a cached rolling summary after an active audit append", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-summary-cache-append-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      const now = new Date("2026-07-04T12:00:00Z");
      const file = join(auditDir, "2026-07-04.jsonl");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(file, JSON.stringify(turn({
        timestamp: "2026-07-04T01:00:00Z",
        tokenUsage: { inputTokens: 100, outputTokens: 10 },
      })) + "\n", "utf-8");

      const first = await getUsageSummary(60, now);
      appendFileSync(file, JSON.stringify(turn({
        timestamp: "2026-07-04T02:00:00Z",
        tokenUsage: { inputTokens: 200, outputTokens: 20 },
      })) + "\n", "utf-8");
      const second = await getUsageSummary(60, now);

      expect(first.today.inputTokens).toBe(100);
      expect(second.today.inputTokens).toBe(300);
      expect(second.today.outputTokens).toBe(30);
    } finally {
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      await cleanupTmpDir(home);
    }
  });

  it("retries a cache hit when an append lands between manifest scans", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-summary-cache-race-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      const file = join(auditDir, "2026-07-04.jsonl");
      const now = new Date("2026-07-04T12:00:00Z");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(file, JSON.stringify(turn({
        timestamp: "2026-07-04T01:00:00Z",
        tokenUsage: { inputTokens: 100, outputTokens: 10 },
      })) + "\n", "utf-8");

      await getUsageSummary(60, now);
      auditStatGate.target = file;
      auditStatGate.appendAfterStatOnCall = 1;
      auditStatGate.append = () => {
        appendFileSync(file, JSON.stringify(turn({
          timestamp: "2026-07-04T02:00:00Z",
          tokenUsage: { inputTokens: 200, outputTokens: 20 },
        })) + "\n", "utf-8");
      };

      const result = await getUsageSummary(60, now);

      expect(auditStatGate.calls).toBeGreaterThanOrEqual(2);
      expect(result.today.inputTokens).toBe(300);
      expect(result.today.outputTokens).toBe(30);
    } finally {
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      await cleanupTmpDir(home);
    }
  });

  it("retries a cache miss when audit data changes during a read", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-summary-cache-miss-race-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      const file = join(auditDir, "2026-07-04.jsonl");
      const now = new Date("2026-07-04T12:00:00Z");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(file, JSON.stringify(turn({
        timestamp: "2026-07-04T01:00:00Z",
        tokenUsage: { inputTokens: 100, outputTokens: 10 },
      })) + "\n", "utf-8");

      auditStatGate.target = file;
      auditStatGate.appendBeforeStatOnCall = 2;
      auditStatGate.append = () => {
        appendFileSync(file, JSON.stringify(turn({
          timestamp: "2026-07-04T02:00:00Z",
          tokenUsage: { inputTokens: 200, outputTokens: 20 },
        })) + "\n", "utf-8");
      };

      const result = await getUsageSummary(60, now);

      expect(auditStatGate.calls).toBeGreaterThanOrEqual(4);
      expect(result.today.inputTokens).toBe(300);
      expect(result.today.outputTokens).toBe(30);
    } finally {
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      await cleanupTmpDir(home);
    }
  });

  it("recovers a usage summary after a corrupt archive is repaired", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-summary-cache-repair-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      const archive = join(auditDir, "2026-07-04.jsonl.20260704.gz");
      const now = new Date("2026-07-04T12:00:00Z");
      const validRows = JSON.stringify(turn({
        timestamp: "2026-07-04T01:00:00Z",
        tokenUsage: { inputTokens: 100, outputTokens: 10 },
      })) + "\n";
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        archive,
        gzipSync(Buffer.from(validRows, "utf-8")).subarray(0, -8),
      );

      const corrupt = await getUsageSummary(60, now);
      writeFileSync(archive, gzipSync(Buffer.from(validRows, "utf-8")));
      const repaired = await getUsageSummary(60, now);

      expect(corrupt.today.inputTokens).toBe(0);
      expect(repaired.today.inputTokens).toBe(100);
      expect(repaired.today.outputTokens).toBe(10);
    } finally {
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      await cleanupTmpDir(home);
    }
  });

  it("uses the local calendar date in the rolling-summary cache key", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-summary-cache-kst-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "2026-07-03.jsonl"),
        JSON.stringify(turn({
          timestamp: "2026-07-03T15:30:00Z",
          tokenUsage: { inputTokens: 100, outputTokens: 10 },
        })) + "\n",
        "utf-8",
      );

      const beforeLocalMidnight = await getUsageSummary(
        60,
        new Date("2026-07-03T14:59:00Z"),
      );
      const afterLocalMidnight = await getUsageSummary(
        60,
        new Date("2026-07-03T15:01:00Z"),
      );

      expect(beforeLocalMidnight.today.inputTokens).toBe(0);
      expect(afterLocalMidnight.today.inputTokens).toBe(100);
    } finally {
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      await cleanupTmpDir(home);
    }
  });

  it("recomputes a cached summary when the pricing override changes", async () => {
    const home = mkdtempSync(join(tmpdir(), "usage-summary-cache-pricing-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(
        join(auditDir, "2026-07-04.jsonl"),
        JSON.stringify(turn({
          timestamp: "2026-07-04T01:00:00Z",
          tokenUsage: { inputTokens: 1_000, outputTokens: 10 },
        })) + "\n",
        "utf-8",
      );
      const now = new Date("2026-07-04T12:00:00Z");

      const defaultPricing = await getUsageSummary(60, now);
      const overrides = resolvePricingOverrides(undefined, {
        LVIS_PRICING_OVERRIDE: JSON.stringify({
          claude: {
            "claude-sonnet-4-6": {
              inputPer1M: 100,
              outputPer1M: 100,
              contextWindow: 1_000_000,
            },
          },
        }),
      });
      const overriddenPricing = await getUsageSummary(60, now, overrides);
      const restoredPricing = await getUsageSummary(60, now);

      expect(overriddenPricing.today.cost).toBeGreaterThan(defaultPricing.today.cost);
      expect(restoredPricing.today.cost).toBeCloseTo(defaultPricing.today.cost, 12);
    } finally {
      delete process.env.LVIS_PRICING_OVERRIDE;
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      await cleanupTmpDir(home);
    }
  });
});

function resetAuditStatGate(): void {
  auditStatGate.target = undefined;
  auditStatGate.append = undefined;
  auditStatGate.appendBeforeStatOnCall = undefined;
  auditStatGate.appendAfterStatOnCall = undefined;
  auditStatGate.calls = 0;
}

// Ensure env override and the stat gate do not bleed between tests.
beforeEach(() => {
  delete process.env.LVIS_PRICING_OVERRIDE;
  resetAuditStatGate();
});
afterEach(() => {
  delete process.env.LVIS_PRICING_OVERRIDE;
  resetAuditStatGate();
});
