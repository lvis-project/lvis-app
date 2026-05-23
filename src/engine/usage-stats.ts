/**
 * Usage Stats Aggregator
 *
 * Parses audit-logger JSONL files (~/.lvis/audit/YYYY-MM-DD.jsonl) and
 * produces token + cost summaries for the Usage Dashboard.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isLLMVendor, type LLMVendor } from "./llm/types.js";
import { getBillableModelPricing, computeCost, normalizeAiSdkUsageForCost } from "./llm/pricing.js";
import { lvisHome } from "../shared/lvis-home.js";

export interface AuditTurnEntry {
  timestamp: string;
  sessionId: string;
  type: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  usageByModel?: Array<{
    vendorProvider: string;
    vendorModel: string;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  }>;
  route?: string;
  input?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  unknownCostTurns?: number;
}

export interface UsagePerVendor extends UsageTotals {
  vendor: string;
  model: string;
}

export interface UsageTrendPoint extends UsageTotals {
  date: string; // YYYY-MM-DD
}

export interface UsageConversation extends UsageTotals {
  sessionId: string;
  turns: number;
  firstInput?: string;
}

export interface UsageSummary {
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  perVendor: UsagePerVendor[];
  perModel: UsagePerVendor[];
  trend: UsageTrendPoint[];
  topConversations: UsageConversation[];
  generatedAt: string;
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

type UsageVendor = LLMVendor | "unknown";

function parseRoute(route: string | undefined): { vendor: UsageVendor; model: string } {
  if (!route) return { vendor: "unknown", model: "unknown" };
  const [v, ...rest] = route.split("/");
  if (!isLLMVendor(v)) {
    // Token-bearing legacy rows with bare routes (`llm`, `skill`, etc.) do
    // not have a defensible provider/model. Keep them visible but explicitly
    // unpriced instead of polluting the current default vendor bucket.
    return { vendor: "unknown", model: route };
  }
  const vendor: LLMVendor = v;
  return { vendor, model: rest.join("/") || "unknown" };
}

type UsageSegment = {
  vendor: UsageVendor;
  model: string;
  tokenUsage: NonNullable<AuditTurnEntry["tokenUsage"]>;
};

function parseUsageSegments(entry: AuditTurnEntry): UsageSegment[] {
  if (entry.usageByModel?.length) {
    return entry.usageByModel
      .filter((segment) => isLLMVendor(segment.vendorProvider))
      .map((segment) => ({
        vendor: segment.vendorProvider as LLMVendor,
        model: segment.vendorModel || "unknown",
        tokenUsage: segment.tokenUsage,
      }));
  }
  if (!entry.tokenUsage) return [];
  const { vendor, model } = parseRoute(entry.route);
  const tokenUsage =
    vendor === "claude"
      // Legacy audit rows without usageByModel were written before the audit
      // boundary carried normalized cost semantics, so treat them as AI SDK raw
      // usage and split Claude cache out before pricing/aggregation.
      ? normalizeAiSdkUsageForCost(entry.tokenUsage, vendor)
      : entry.tokenUsage;
  return [{ vendor, model, tokenUsage }];
}

function addTo(
  target: UsageTotals,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  vendor: UsageVendor,
  cost: number,
  costKnown: boolean,
): void {
  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheReadTokens += cacheRead;
  target.cacheWriteTokens += cacheWrite;
  // totalTokens 의미는 vendor 별로 다르다 — Anthropic 은 input + cache 가산,
  // OpenAI/Gemini 는 cache 가 이미 input 안에 포함 (Vercel SDK normalized
  // cachedInputTokens). Unknown legacy rows stay input+output only because
  // cache semantics are not knowable and must not inflate visible totals.
  target.totalTokens +=
    vendor === "claude"
      ? input + output + cacheRead + cacheWrite
      : input + output;
  target.cost += cost;
  if (!costKnown) target.unknownCostTurns = (target.unknownCostTurns ?? 0) + 1;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO week starts Monday. */
function weekStart(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  const day = x.getUTCDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? 6 : day - 1);
  x.setUTCDate(x.getUTCDate() - diff);
  return x;
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Read audit JSONL entries from ~/.lvis/audit for the last `days` days.
 */
export function readAuditEntries(auditDir: string, days: number = 60): AuditTurnEntry[] {
  if (!existsSync(auditDir)) return [];
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffKey = dateKey(cutoff);

  const files = readdirSync(auditDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => f.slice(0, 10) >= cutoffKey)
    .sort();

  const out: AuditTurnEntry[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(auditDir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditTurnEntry;
        if (entry.type === "turn") out.push(entry);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}

/**
 * Compute aggregated usage summary from audit turn entries.
 */
export function computeUsageSummary(
  entries: AuditTurnEntry[],
  now: Date = new Date(),
): UsageSummary {
  const todayKey = dateKey(now);
  const weekKey = dateKey(weekStart(now));
  const monthKey = dateKey(monthStart(now));

  const today = emptyTotals();
  const thisWeek = emptyTotals();
  const thisMonth = emptyTotals();

  const perVendorMap = new Map<string, UsagePerVendor>();
  const perModelMap = new Map<string, UsagePerVendor>();
  const trendMap = new Map<string, UsageTrendPoint>();
  const convMap = new Map<string, UsageConversation>();

  for (const e of entries) {
    const segments = parseUsageSegments(e);
    if (segments.length === 0) continue;
    const ts = new Date(e.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    const dKey = dateKey(ts);

    // per conversation
    let c = convMap.get(e.sessionId);
    if (!c) {
      c = { sessionId: e.sessionId, turns: 0, firstInput: e.input, ...emptyTotals() };
      convMap.set(e.sessionId, c);
    }
    c.turns += 1;

    for (const segment of segments) {
      const { vendor, model, tokenUsage } = segment;
      const {
        inputTokens,
        outputTokens,
        cacheReadTokens = 0,
        cacheWriteTokens = 0,
      } = tokenUsage;
      const pricing = vendor !== "unknown" ? getBillableModelPricing(vendor, model) : undefined;
      const costKnown = !!pricing;
      const cost = pricing && vendor !== "unknown"
        ? computeCost(
            { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
            pricing,
            vendor,
          )
        : 0;

      if (dKey === todayKey) addTo(today, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, costKnown);
      if (dKey >= weekKey) addTo(thisWeek, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, costKnown);
      if (dKey >= monthKey) addTo(thisMonth, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, costKnown);

      const vKey = vendor;
      let v = perVendorMap.get(vKey);
      if (!v) {
        v = { vendor, model: "*", ...emptyTotals() };
        perVendorMap.set(vKey, v);
      }
      addTo(v, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, costKnown);

      const mKey = `${vendor}/${model}`;
      let m = perModelMap.get(mKey);
      if (!m) {
        m = { vendor, model, ...emptyTotals() };
        perModelMap.set(mKey, m);
      }
      addTo(m, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, costKnown);

      let t = trendMap.get(dKey);
      if (!t) {
        t = { date: dKey, ...emptyTotals() };
        trendMap.set(dKey, t);
      }
      addTo(t, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, costKnown);
      addTo(c, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, vendor, cost, costKnown);
    }
  }

  const trend = Array.from(trendMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const topConversations = Array.from(convMap.values())
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens)
    .slice(0, 5);

  return {
    today,
    thisWeek,
    thisMonth,
    perVendor: Array.from(perVendorMap.values()).sort((a, b) => b.cost - a.cost),
    perModel: Array.from(perModelMap.values()).sort((a, b) => b.cost - a.cost),
    trend,
    topConversations,
    generatedAt: now.toISOString(),
  };
}

export interface UsageRangeOptions {
  dateFrom: string; // YYYY-MM-DD inclusive
  dateTo: string;   // YYYY-MM-DD inclusive
}

/**
 * Compute a usage summary filtered to an explicit date range.
 * Reads only JSONL files whose filename date falls within the range.
 */
export function getUsageRange(opts: UsageRangeOptions): UsageSummary {
  const auditDir = join(lvisHome(), "audit");
  if (!existsSync(auditDir)) return computeUsageSummary([]);

  const files = readdirSync(auditDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => {
      const d = f.slice(0, 10);
      return d >= opts.dateFrom && d <= opts.dateTo;
    })
    .sort();

  const entries: AuditTurnEntry[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(auditDir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditTurnEntry;
        if (entry.type === "turn") entries.push(entry);
      } catch {
        // skip malformed
      }
    }
  }

  const filtered = entries.filter((e) => {
    const d = e.timestamp.slice(0, 10);
    return d >= opts.dateFrom && d <= opts.dateTo;
  });

  return computeUsageSummary(filtered);
}

/**
 * Compute avg cost per day and project a 30-day monthly estimate.
 * Accepts a trend array directly. Returns 0 when there are no trend points.
 */
export function computeMonthlyProjection(trend: UsageTrendPoint[]): number {
  if (trend.length === 0) return 0;
  const totalCost = trend.reduce((s, p) => s + p.cost, 0);
  const avgPerDay = totalCost / trend.length;
  return avgPerDay * 30;
}

/** Default convenience — reads from `~/.lvis/audit` and computes a 60-day summary. */
export function getUsageSummary(days: number = 60): UsageSummary {
  const auditDir = join(lvisHome(), "audit");
  const entries = readAuditEntries(auditDir, days);
  return computeUsageSummary(entries);
}
