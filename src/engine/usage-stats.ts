/**
 * Usage Stats Aggregator
 *
 * Parses audit-logger JSONL files (~/.lvis/audit/YYYY-MM-DD.jsonl) and
 * produces token + cost summaries for the Usage Dashboard.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { iterateJsonlLines, withAuditSnapshotLock } from "../audit/jsonl-reader.js";
import { kstDateKey, kstMonthStartKey, kstWeekStartKey, shiftKstDateKey } from "../shared/kst-date.js";
import { lvisHome } from "../shared/lvis-home.js";
import { isLLMVendor, type LLMVendor } from "./llm/types.js";
import { getBillableModelPricing, computeCost, normalizeAiSdkUsageForCost } from "./llm/pricing.js";

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


  // cachedInputTokens). Unknown legacy rows stay input+output only because
  // cache semantics are not knowable and must not inflate visible totals.
  target.totalTokens +=
    vendor === "claude"
      ? input + output + cacheRead + cacheWrite
      : input + output;
  target.cost += cost;
  if (!costKnown) target.unknownCostTurns = (target.unknownCostTurns ?? 0) + 1;
}

interface UsageAuditFile {
  name: string;
  date: string;
  archiveOrder: string;
}

const RAW_USAGE_AUDIT_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const LEGACY_USAGE_AUDIT_ARCHIVE = /^(\d{4}-\d{2}-\d{2})\.jsonl\.(\d{8})\.gz$/;
const UNIQUE_USAGE_AUDIT_ARCHIVE = /^(\d{4}-\d{2}-\d{2})\.jsonl\.(\d{17})\.[0-9a-f-]{36}\.gz$/i;

function parseUsageAuditFile(name: string): UsageAuditFile | undefined {
  const raw = RAW_USAGE_AUDIT_FILE.exec(name);
  if (raw) return { name, date: raw[1], archiveOrder: "~" };

  const legacy = LEGACY_USAGE_AUDIT_ARCHIVE.exec(name);
  if (legacy) return { name, date: legacy[1], archiveOrder: `${legacy[2]}000000000` };

  const unique = UNIQUE_USAGE_AUDIT_ARCHIVE.exec(name);
  if (unique) return { name, date: unique[1], archiveOrder: unique[2] };

  return undefined;
}

async function listUsageAuditFiles(auditDir: string): Promise<UsageAuditFile[]> {
  let names: string[];
  try {
    names = await readdir(auditDir);
  } catch {
    return [];
  }
  return names
    .map(parseUsageAuditFile)
    .filter((file): file is UsageAuditFile => file !== undefined)
    .sort((a, b) => (
      a.date.localeCompare(b.date)
      || a.archiveOrder.localeCompare(b.archiveOrder)
      || a.name.localeCompare(b.name)
    ));
}

async function readUsageAuditEntries(
  auditDir: string,
  matchesFile: (file: UsageAuditFile) => boolean,
  matchesEntry: (entry: AuditTurnEntry) => boolean = () => true,
): Promise<AuditTurnEntry[]> {
  return withAuditSnapshotLock(
    auditDir,
    async () => {
      const files = (await listUsageAuditFiles(auditDir)).filter(matchesFile);
      const out: AuditTurnEntry[] = [];

      for (const file of files) {
        // Only commit a file's rows after its stream completes. A corrupted gzip can
        // yield valid prefix rows before failing, which must not become partial usage.
        const rows: AuditTurnEntry[] = [];
        try {
          for await (const line of iterateJsonlLines(join(auditDir, file.name))) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as AuditTurnEntry;
              if (entry.type === "turn" && matchesEntry(entry)) rows.push(entry);
            } catch {
              // Skip malformed rows while retaining valid records in this file.
            }
          }
          out.push(...rows);
        } catch {
          // A bad or disappearing file must not hide usage from other audit files.
        }
      }

      return out;
    },
  );
}

/**
 * Read audit JSONL entries from ~/.lvis/audit for the last `days` days.
 */
export async function readAuditEntries(
  auditDir: string,
  days: number = 60,
  now: Date = new Date(),
): Promise<AuditTurnEntry[]> {
  const cutoffDateKey = shiftKstDateKey(kstDateKey(now), -days);
  const cutoffFileKey = shiftKstDateKey(cutoffDateKey, -1);
  return readUsageAuditEntries(
    auditDir,
    (file) => file.date >= cutoffFileKey,
    (entry) => {
      const timestamp = new Date(entry.timestamp);
      return !Number.isNaN(timestamp.getTime()) && kstDateKey(timestamp) >= cutoffDateKey;
    },
  );
}

/**
 * Compute aggregated usage summary from audit turn entries.
 */
export function computeUsageSummary(
  entries: AuditTurnEntry[],
  now: Date = new Date(),
): UsageSummary {
  const todayKey = kstDateKey(now);
  const weekKey = kstWeekStartKey(now);
  const monthKey = kstMonthStartKey(now);

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
    const dKey = kstDateKey(ts);

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
export async function getUsageRange(
  opts: UsageRangeOptions,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const auditDir = join(lvisHome(), "audit");
  const entries = await readUsageAuditEntries(
    auditDir,
    (file) => (
      file.date >= shiftKstDateKey(opts.dateFrom, -1)
      && file.date <= shiftKstDateKey(opts.dateTo, 1)
    ),
  );

  const filtered = entries.filter((entry) => {
    const timestamp = new Date(entry.timestamp);
    if (Number.isNaN(timestamp.getTime())) return false;
    const date = kstDateKey(timestamp);
    return date >= opts.dateFrom && date <= opts.dateTo;
  });

  return computeUsageSummary(filtered, now);
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
export async function getUsageSummary(
  days: number = 60,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const auditDir = join(lvisHome(), "audit");
  const entries = await readAuditEntries(auditDir, days, now);
  return computeUsageSummary(entries, now);
}
