/**
 * Usage Stats Aggregator — Sprint 4.B
 *
 * Parses audit-logger JSONL files (~/.lvis/audit/YYYY-MM-DD.jsonl) and
 * produces token + cost summaries for the Usage Dashboard.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isLLMVendor, type LLMVendor } from "./llm/types.js";
import { DEFAULT_LLM_VENDOR } from "../shared/llm-vendor-defaults.js";
import { getModelPricing, computeCost } from "./llm/pricing.js";

export interface AuditTurnEntry {
  timestamp: string;
  sessionId: string;
  type: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  route?: string;
  input?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export interface UsagePerVendor extends UsageTotals {
  vendor: string;
  model: string;
}

export interface UsageTrendPoint {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
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
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
}

/**
 * Parse a route string `"vendor/model"` into `{ vendor, model }`.
 * Fallback: `{ vendor: DEFAULT_LLM_VENDOR, model: "unknown" }`.
 *
 * NOTE (audit-log shape mismatch — pre-existing): `AuditTurnEntry.route`
 * is currently logged as the route classification ("llm" / "skill" /
 * "command") by `AuditLogger.logTurn`, NOT as a `vendor/model` pair.
 * This function therefore falls through to the default for the majority
 * of audit entries — per-vendor / per-model cost breakdown is inaccurate
 * until the logger is updated to emit `${vendor}/${model}` (out of scope
 * for this PR, which only tightens the LLMVendor *type* contract).
 */
function parseRoute(route: string | undefined): { vendor: LLMVendor; model: string } {
  if (!route) return { vendor: DEFAULT_LLM_VENDOR, model: "unknown" };
  const [v, ...rest] = route.split("/");
  // Use the runtime type guard rather than a hand-rolled allow-list — the
  // previous list was missing `azure-foundry` and `vertex-ai`, so usage
  // logs from those vendors silently coerced to "claude" and got attributed
  // to the wrong cost bucket. isLLMVendor stays in sync with LLM_VENDORS.
  const vendor: LLMVendor = isLLMVendor(v) ? v : DEFAULT_LLM_VENDOR;
  return { vendor, model: rest.join("/") || "unknown" };
}

function addTo(target: UsageTotals, input: number, output: number, cost: number): void {
  target.inputTokens += input;
  target.outputTokens += output;
  target.totalTokens += input + output;
  target.cost += cost;
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
    if (!e.tokenUsage) continue;
    const { inputTokens, outputTokens } = e.tokenUsage;
    const { vendor, model } = parseRoute(e.route);
    const pricing = getModelPricing(vendor, model);
    const cost = computeCost(inputTokens, outputTokens, pricing);
    const ts = new Date(e.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    const dKey = dateKey(ts);

    if (dKey === todayKey) addTo(today, inputTokens, outputTokens, cost);
    if (dKey >= weekKey) addTo(thisWeek, inputTokens, outputTokens, cost);
    if (dKey >= monthKey) addTo(thisMonth, inputTokens, outputTokens, cost);

    // per vendor
    const vKey = vendor;
    let v = perVendorMap.get(vKey);
    if (!v) {
      v = { vendor, model: "*", ...emptyTotals() };
      perVendorMap.set(vKey, v);
    }
    addTo(v, inputTokens, outputTokens, cost);

    // per model
    const mKey = `${vendor}/${model}`;
    let m = perModelMap.get(mKey);
    if (!m) {
      m = { vendor, model, ...emptyTotals() };
      perModelMap.set(mKey, m);
    }
    addTo(m, inputTokens, outputTokens, cost);

    // trend
    let t = trendMap.get(dKey);
    if (!t) {
      t = { date: dKey, ...emptyTotals() } as UsageTrendPoint;
      trendMap.set(dKey, t);
    }
    addTo(t, inputTokens, outputTokens, cost);

    // per conversation
    let c = convMap.get(e.sessionId);
    if (!c) {
      c = { sessionId: e.sessionId, turns: 0, firstInput: e.input, ...emptyTotals() };
      convMap.set(e.sessionId, c);
    }
    c.turns += 1;
    addTo(c, inputTokens, outputTokens, cost);
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
  const auditDir = join(homedir(), ".lvis", "audit");
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
  const auditDir = join(homedir(), ".lvis", "audit");
  const entries = readAuditEntries(auditDir, days);
  return computeUsageSummary(entries);
}
