import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeUsageSummary,
  readAuditEntries,
  computeMonthlyProjection,
  getUsageRange,
  type AuditTurnEntry,
  type UsageTrendPoint
} from "../usage-stats.js";
import { getModelPricing, computeCost } from "../llm/pricing.js";

function turn(partial: Partial<AuditTurnEntry>): AuditTurnEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "s1",
    type: "turn",
    route: "claude/claude-sonnet-4-6",
    tokenUsage: { inputTokens: 1000, outputTokens: 500 },
    ...partial
  };
}

describe("usage-stats", () => {
  it("aggregates today/week/month totals from turn entries", () => {
    const now = new Date("2026-04-18T12:00:00Z"); // Saturday
    const entries: AuditTurnEntry[] = [
      turn({ timestamp: "2026-04-18T10:00:00Z", tokenUsage: { inputTokens: 1_000_000, outputTokens: 500_000 } }),
      // Monday of same week
      turn({ timestamp: "2026-04-13T10:00:00Z", tokenUsage: { inputTokens: 200_000, outputTokens: 100_000 } }),
      // Earlier in month
      turn({ timestamp: "2026-04-02T10:00:00Z", tokenUsage: { inputTokens: 50_000, outputTokens: 25_000 } }),
      // Previous month — should only count toward trend, not today/week/month
      turn({ timestamp: "2026-03-15T10:00:00Z", tokenUsage: { inputTokens: 10_000, outputTokens: 5_000 } }),
    ];

    const summary = computeUsageSummary(entries, now);
    expect(summary.today.inputTokens).toBe(1_000_000);
    expect(summary.today.outputTokens).toBe(500_000);
    expect(summary.thisWeek.inputTokens).toBe(1_200_000);
    expect(summary.thisMonth.inputTokens).toBe(1_250_000);
  });

  it("uses KST calendar days for today and trend around UTC midnight", () => {
    const now = new Date("2026-07-03T16:00:00Z"); // 2026-07-04 01:00 KST
    const entries: AuditTurnEntry[] = [
      turn({ timestamp: "2026-07-03T15:30:00Z", tokenUsage: { inputTokens: 100, outputTokens: 10 } }),
      turn({ timestamp: "2026-07-03T14:30:00Z", tokenUsage: { inputTokens: 300, outputTokens: 30 } }),
    ];

    const summary = computeUsageSummary(entries, now);
    expect(summary.today.inputTokens).toBe(100);
    expect(summary.trend.map((point) => [point.date, point.inputTokens])).toEqual([
      ["2026-07-03", 300],
      ["2026-07-04", 100],
    ]);
  });

  it("computes cost using pricing table — Claude Sonnet $3/$15 per 1M", () => {
    const entries = [turn({ tokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } })];
    const summary = computeUsageSummary(entries, new Date());
    // $3 input + $15 output = $18
    expect(summary.perVendor[0].cost).toBeCloseTo(18, 5);
    expect(summary.perVendor[0].vendor).toBe("claude");
  });

  it("groups by model and session, ranks topConversations by cost", () => {
    const entries: AuditTurnEntry[] = [
      turn({ sessionId: "expensive", tokenUsage: { inputTokens: 2_000_000, outputTokens: 1_000_000 } }),
      turn({ sessionId: "cheap", tokenUsage: { inputTokens: 1000, outputTokens: 500 } }),
      turn({ sessionId: "expensive", tokenUsage: { inputTokens: 500_000, outputTokens: 200_000 } }),
    ];
    const summary = computeUsageSummary(entries, new Date());
    expect(summary.topConversations[0].sessionId).toBe("expensive");
    expect(summary.topConversations[0].turns).toBe(2);
    expect(summary.perModel[0].model).toBe("claude-sonnet-4-6");
  });

  it("respects env pricing override", () => {
    process.env.LVIS_PRICING_OVERRIDE = JSON.stringify({
      claude: { "claude-sonnet-4-6": { inputPer1M: 100, outputPer1M: 100, contextWindow: 1_000_000 } }
    });
    try {
      const p = getModelPricing("claude", "claude-sonnet-4-6");
      expect(p.inputPer1M).toBe(100);
      expect(
        computeCost(
          { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          p,
          "claude",
        ),
      ).toBeCloseTo(200, 5);
    } finally {
      delete process.env.LVIS_PRICING_OVERRIDE;
    }
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
        const flash = { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 };
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
        route: "skill",
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
    expect(summary.perModel[0].model).toBe("skill");
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
    expect(summary.perVendor.map((row) => row.vendor).sort()).toEqual(["claude", "openai"]);
    expect(summary.perModel.map((row) => `${row.vendor}/${row.model}`).sort()).toEqual([
      "claude/claude-sonnet-4-6",
      "openai/gpt-5.4-mini",
    ]);
    expect(summary.perVendor.find((row) => row.vendor === "claude")?.totalTokens).toBe(1_800_000);
    expect(summary.perVendor.find((row) => row.vendor === "openai")?.totalTokens).toBe(11_000);
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
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      sonnet,
      "claude",
    );
    const fresh = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      sonnet,
      "claude",
    );
    expect(cached).toBeCloseTo(0.30, 5);
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
    const fresh = computeCost({ inputTokens: 1_000_000, outputTokens: 0 }, gpt54mini, "openai");
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
    const summary = computeUsageSummary(entries, new Date("2026-04-12T12:00:00Z"));
    expect(summary.trend.map((t) => t.date)).toEqual(["2026-04-10", "2026-04-11", "2026-04-12"]);
  });

  it("reads JSONL audit files and ignores non-turn entries", () => {
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
          JSON.stringify({ type: "tool_call", timestamp: `${dateStr}T10:05:00Z` }),
          "not json",
          "",
          JSON.stringify(turn({ timestamp: `${dateStr}T11:00:00Z` })),
        ].join("\n") + "\n",
        "utf-8",
      );
      const read = readAuditEntries(dir, 365);
      expect(read.length).toBe(2);
      expect(read.every((e) => e.type === "turn")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeMonthlyProjection", () => {
  it("returns 0 for empty trend", () => {
    expect(computeMonthlyProjection([])).toBe(0);
  });

  it("projects avg-per-day × 30", () => {
    const trend: UsageTrendPoint[] = [
      { date: "2026-04-01", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 1.0 },
      { date: "2026-04-02", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 3.0 },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(60, 5);
  });

  it("projects correctly for a single day", () => {
    const trend: UsageTrendPoint[] = [
      { date: "2026-04-01", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0.5 },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(15, 5);
  });
});

describe("getUsageRange (via readAuditEntries + filter)", () => {
  it("filters entries to exact date range", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-range-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "2026-04-10.jsonl"),
        JSON.stringify({ timestamp: "2026-04-10T10:00:00Z", sessionId: "s1", type: "turn", route: "claude/claude-sonnet-4-6", tokenUsage: { inputTokens: 100, outputTokens: 50 } }) + "\n", "utf-8");
      writeFileSync(join(dir, "2026-04-15.jsonl"),
        JSON.stringify({ timestamp: "2026-04-15T10:00:00Z", sessionId: "s1", type: "turn", route: "claude/claude-sonnet-4-6", tokenUsage: { inputTokens: 200, outputTokens: 100 } }) + "\n", "utf-8");
      writeFileSync(join(dir, "2026-04-20.jsonl"),
        JSON.stringify({ timestamp: "2026-04-20T10:00:00Z", sessionId: "s1", type: "turn", route: "claude/claude-sonnet-4-6", tokenUsage: { inputTokens: 400, outputTokens: 200 } }) + "\n", "utf-8");

      const entries = readAuditEntries(dir, 365).filter((e) => {
        const d = e.timestamp.slice(0, 10);
        return d >= "2026-04-10" && d <= "2026-04-15";
      });
      const summary = computeUsageSummary(entries);
      expect(summary.trend.map((t) => t.date)).toEqual(["2026-04-10", "2026-04-15"]);
      expect(summary.trend[0].inputTokens).toBe(100);
      expect(summary.trend[1].inputTokens).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads adjacent UTC audit files for a selected KST day", () => {
    const home = mkdtempSync(join(tmpdir(), "usage-range-kst-home-"));
    const originalHome = process.env.LVIS_HOME;
    try {
      process.env.LVIS_HOME = home;
      const auditDir = join(home, "audit");
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(join(auditDir, "2026-07-03.jsonl"), [
        JSON.stringify({ timestamp: "2026-07-03T14:30:00Z", sessionId: "s1", type: "turn", route: "claude/claude-sonnet-4-6", tokenUsage: { inputTokens: 300, outputTokens: 30 } }),
        JSON.stringify({ timestamp: "2026-07-03T15:30:00Z", sessionId: "s1", type: "turn", route: "claude/claude-sonnet-4-6", tokenUsage: { inputTokens: 100, outputTokens: 10 } }),
      ].join("\n") + "\n", "utf-8");

      const summary = getUsageRange({ dateFrom: "2026-07-04", dateTo: "2026-07-04" });
      expect(summary.trend.map((point) => point.date)).toEqual(["2026-07-04"]);
      expect(summary.trend[0].inputTokens).toBe(100);
    } finally {
      if (originalHome === undefined) {
        delete process.env.LVIS_HOME;
      } else {
        process.env.LVIS_HOME = originalHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Ensure env override cache does not bleed between tests.
beforeEach(() => { delete process.env.LVIS_PRICING_OVERRIDE; });
afterEach(() => { delete process.env.LVIS_PRICING_OVERRIDE; });
