import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  computeUsageSummary,
  readAuditEntries,
  computeMonthlyProjection,
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
      expect(computeCost(1_000_000, 1_000_000, p)).toBeCloseTo(200, 5);
    } finally {
      delete process.env.LVIS_PRICING_OVERRIDE;
    }
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
    const dir = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "usage-stats-"));
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "2026-04-18.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify(turn({ timestamp: "2026-04-18T10:00:00Z" })),
          JSON.stringify({ type: "tool_call", timestamp: "2026-04-18T10:05:00Z" }),
          "not json",
          "",
          JSON.stringify(turn({ timestamp: "2026-04-18T11:00:00Z" })),
        ].join("\n") + "\n",
        "utf-8",
      );
      const read = readAuditEntries(dir, 30);
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
      { date: "2026-04-01", inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 1.0 },
      { date: "2026-04-02", inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 3.0 },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(60, 5);
  });

  it("projects correctly for a single day", () => {
    const trend: UsageTrendPoint[] = [
      { date: "2026-04-01", inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0.5 },
    ];
    expect(computeMonthlyProjection(trend)).toBeCloseTo(15, 5);
  });
});

describe("getUsageRange (via readAuditEntries + filter)", () => {
  it("filters entries to exact date range", () => {
    const dir = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "usage-range-"));
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
});

// Ensure env override cache does not bleed between tests.
beforeEach(() => { delete process.env.LVIS_PRICING_OVERRIDE; });
afterEach(() => { delete process.env.LVIS_PRICING_OVERRIDE; });
