/**
 * Usage Stats Aggregator
 *
 * Parses audit-logger JSONL files (~/.lvis/audit/YYYY-MM-DD.jsonl) and
 * produces token + cost summaries for the Usage Dashboard.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { iterateJsonlLines, withAuditSnapshotLock } from "../audit/jsonl-reader.js";
import type { AuditTokenUsage, AuditUsageByModelSegment } from "../audit/audit-logger.js";

import { localDateKey, localMonthStartKey, localMondayWeekStartKey, shiftLocalDateKey } from "../shared/local-date.js";
import { lvisHome } from "../shared/lvis-home.js";
import {
  normalizeSubscriptionUsageTelemetry,
  type SubscriptionRuntimeId,
  type SubscriptionUsageSource,
  type SubscriptionUsageTelemetry,
} from "../shared/subscription-runtime.js";
import { isLLMVendor, type LLMVendor } from "./llm/types.js";
import { getBillableModelPricing, computeCost, normalizeAiSdkUsageForCost } from "./llm/pricing.js";
import { pricingOverridesSignature, type PricingOverride } from "../shared/pricing-overrides.js";

export interface AuditTurnEntry {
  timestamp: string;
  sessionId: string;
  type: string;
  tokenUsage?: AuditTokenUsage;
  usageByModel?: AuditUsageByModelSegment[];
  /** Untrusted persisted subscription telemetry; normalize before use. */
  subscriptionUsage?: unknown;
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

/**
 * Token-only consumption under an authenticated subscription.
 *
 * This intentionally has no `cost` field. Subscription telemetry is never
 * passed to API-key pricing, cost projections, or API usage breakdowns.
 */
interface SubscriptionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Number of measured provider request segments, not billable API turns. */
  segments: number;
}

interface SubscriptionUsagePerRuntime extends SubscriptionUsageTotals {
  provider: SubscriptionRuntimeId;
  model: string;
}

interface SubscriptionUsageTrendPoint extends SubscriptionUsageTotals {
  date: string; // YYYY-MM-DD
}

interface SubscriptionUsageSummary {
  today: SubscriptionUsageTotals;
  thisWeek: SubscriptionUsageTotals;
  thisMonth: SubscriptionUsageTotals;
  /** One row per subscription runtime, with `model: "*"`. */
  perRuntime: SubscriptionUsagePerRuntime[];
  /** One row per subscription runtime/model pair. */
  perModel: SubscriptionUsagePerRuntime[];
  trend: SubscriptionUsageTrendPoint[];
  /** Separate provenance totals; never interpreted as price information. */
  sources: Record<SubscriptionUsageSource, SubscriptionUsageTotals>;
}

export interface UsageSummary {
  today: UsageTotals;
  thisWeek: UsageTotals;
  thisMonth: UsageTotals;
  perVendor: UsagePerVendor[];
  perModel: UsagePerVendor[];
  trend: UsageTrendPoint[];
  topConversations: UsageConversation[];
  subscription: SubscriptionUsageSummary;
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

function emptySubscriptionTotals(): SubscriptionUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    segments: 0,
  };
}

function emptySubscriptionSources(): Record<SubscriptionUsageSource, SubscriptionUsageTotals> {
  return {
    "provider-reported": emptySubscriptionTotals(),
    "local-estimate": emptySubscriptionTotals(),
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

function parseSubscriptionUsageSegments(entry: AuditTurnEntry): SubscriptionUsageTelemetry[] {
  if (!Array.isArray(entry.subscriptionUsage)) return [];
  const segments: SubscriptionUsageTelemetry[] = [];
  for (const raw of entry.subscriptionUsage) {
    const telemetry = normalizeSubscriptionUsageTelemetry(raw);
    if (telemetry) segments.push(telemetry);
  }
  return segments;
}

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

function addSubscriptionTo(
  target: SubscriptionUsageTotals,
  telemetry: SubscriptionUsageTelemetry,
): void {
  target.inputTokens += telemetry.inputTokens;
  target.outputTokens += telemetry.outputTokens;
  target.cacheReadTokens += telemetry.cacheReadTokens ?? 0;
  target.cacheWriteTokens += telemetry.cacheWriteTokens ?? 0;
  target.reasoningOutputTokens += telemetry.reasoningOutputTokens ?? 0;
  // `totalTokens` is the verified provider total or the local estimator's
  // canonical total. Do not reconstruct it from cache/reasoning subfields.
  target.totalTokens += telemetry.totalTokens;
  target.segments += 1;
}

interface UsageAuditFile {
  name: string;
  date: string;
  archiveOrder: string;
}

interface UsageAuditFileManifest {
  name: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface UsageAuditFileSnapshot {
  file: UsageAuditFile;
  manifest: UsageAuditFileManifest;
}

interface UsageAuditSnapshot {
  files: UsageAuditFile[];
  manifest: UsageAuditFileManifest[];
  complete: boolean;
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

async function tryListUsageAuditFiles(auditDir: string): Promise<UsageAuditFile[] | undefined> {
  let names: string[];
  try {
    names = await readdir(auditDir);
  } catch {
    return undefined;
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

async function listUsageAuditFiles(auditDir: string): Promise<UsageAuditFile[]> {
  return (await tryListUsageAuditFiles(auditDir)) ?? [];
}

async function snapshotUsageAuditFiles(
  auditDir: string,
  matchesFile: (file: UsageAuditFile) => boolean,
): Promise<UsageAuditSnapshot> {
  const listed = await tryListUsageAuditFiles(auditDir);
  if (!listed) return { files: [], manifest: [], complete: false };
  const files = listed.filter(matchesFile);
  const snapshots: Array<UsageAuditFileSnapshot | undefined> = await Promise.all(
    files.map(async (file) => {
      try {
        const metadata = await stat(join(auditDir, file.name));
        if (!metadata.isFile()) return undefined;
        return {
          file,
          manifest: {
            name: file.name,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            ctimeMs: metadata.ctimeMs,
          },
        };
      } catch {
        return undefined;
      }
    }),
  );
  const present = snapshots.filter((snapshot): snapshot is UsageAuditFileSnapshot => (
    snapshot !== undefined
  ));
  return {
    files,
    manifest: present.map((snapshot) => snapshot.manifest),
    complete: present.length === files.length,
  };
}

interface UsageAuditEntryRead {
  entries: AuditTurnEntry[];
  complete: boolean;
}

async function readUsageAuditEntriesWithStatus(
  auditDir: string,
  files: readonly UsageAuditFile[],
  matchesEntry: (entry: AuditTurnEntry) => boolean = () => true,
): Promise<UsageAuditEntryRead> {
  const entries: AuditTurnEntry[] = [];
  let complete = true;

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
      entries.push(...rows);
    } catch {
      // A bad or disappearing file must not hide usage from other audit files.
      complete = false;
    }
  }

  return { entries, complete };
}

async function readUsageAuditEntriesFromFiles(
  auditDir: string,
  files: readonly UsageAuditFile[],
  matchesEntry: (entry: AuditTurnEntry) => boolean = () => true,
): Promise<AuditTurnEntry[]> {
  return (await readUsageAuditEntriesWithStatus(auditDir, files, matchesEntry)).entries;
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
      return readUsageAuditEntriesFromFiles(auditDir, files, matchesEntry);
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
  const cutoffDateKey = shiftLocalDateKey(localDateKey(now), -days);
  const cutoffFileKey = shiftLocalDateKey(cutoffDateKey, -1);
  return readUsageAuditEntries(
    auditDir,
    (file) => file.date >= cutoffFileKey,
    (entry) => {
      const timestamp = new Date(entry.timestamp);
      return !Number.isNaN(timestamp.getTime()) && localDateKey(timestamp) >= cutoffDateKey;
    },
  );
}

/**
 * Compute aggregated usage summary from audit turn entries.
 *
 * `pricingOverrides` is the resolved list (Settings, or the deployment's
 * `LVIS_PRICING_OVERRIDE`) — passed in rather than read here, because the
 * cache above keys on it and a value this function fetched for itself could
 * differ from the one the key was built from.
 */
export function computeUsageSummary(
  entries: AuditTurnEntry[],
  now: Date = new Date(),
  pricingOverrides: readonly PricingOverride[] = [],
): UsageSummary {
  const todayKey = localDateKey(now);
  const weekKey = localMondayWeekStartKey(now);
  const monthKey = localMonthStartKey(now);

  const today = emptyTotals();
  const thisWeek = emptyTotals();
  const thisMonth = emptyTotals();

  const perVendorMap = new Map<string, UsagePerVendor>();
  const perModelMap = new Map<string, UsagePerVendor>();
  const trendMap = new Map<string, UsageTrendPoint>();
  const convMap = new Map<string, UsageConversation>();

  const subscription = {
    today: emptySubscriptionTotals(),
    thisWeek: emptySubscriptionTotals(),
    thisMonth: emptySubscriptionTotals(),
    perRuntime: [] as SubscriptionUsagePerRuntime[],
    perModel: [] as SubscriptionUsagePerRuntime[],
    trend: [] as SubscriptionUsageTrendPoint[],
    sources: emptySubscriptionSources(),
  };
  const subscriptionPerRuntimeMap = new Map<SubscriptionRuntimeId, SubscriptionUsagePerRuntime>();
  const subscriptionPerModelMap = new Map<string, SubscriptionUsagePerRuntime>();
  const subscriptionTrendMap = new Map<string, SubscriptionUsageTrendPoint>();

  for (const e of entries) {
    const ts = new Date(e.timestamp);
    if (Number.isNaN(ts.getTime())) continue;
    const dKey = localDateKey(ts);

    for (const telemetry of parseSubscriptionUsageSegments(e)) {
      if (dKey === todayKey) addSubscriptionTo(subscription.today, telemetry);
      if (dKey >= weekKey) addSubscriptionTo(subscription.thisWeek, telemetry);
      if (dKey >= monthKey) addSubscriptionTo(subscription.thisMonth, telemetry);
      addSubscriptionTo(subscription.sources[telemetry.source], telemetry);

      let runtime = subscriptionPerRuntimeMap.get(telemetry.provider);
      if (!runtime) {
        runtime = { provider: telemetry.provider, model: "*", ...emptySubscriptionTotals() };
        subscriptionPerRuntimeMap.set(telemetry.provider, runtime);
      }
      addSubscriptionTo(runtime, telemetry);

      const modelKey = `${telemetry.provider}\u0000${telemetry.model}`;
      let model = subscriptionPerModelMap.get(modelKey);
      if (!model) {
        model = { provider: telemetry.provider, model: telemetry.model, ...emptySubscriptionTotals() };
        subscriptionPerModelMap.set(modelKey, model);
      }
      addSubscriptionTo(model, telemetry);

      let trendPoint = subscriptionTrendMap.get(dKey);
      if (!trendPoint) {
        trendPoint = { date: dKey, ...emptySubscriptionTotals() };
        subscriptionTrendMap.set(dKey, trendPoint);
      }
      addSubscriptionTo(trendPoint, telemetry);
    }

    const segments = parseUsageSegments(e);
    if (segments.length === 0) continue;

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
      const pricing = vendor !== "unknown"
        ? getBillableModelPricing(vendor, model, pricingOverrides)
        : undefined;
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

  subscription.perRuntime = Array.from(subscriptionPerRuntimeMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));
  subscription.perModel = Array.from(subscriptionPerModelMap.values())
    .sort((a, b) => (
      b.totalTokens - a.totalTokens
      || a.provider.localeCompare(b.provider)
      || a.model.localeCompare(b.model)
    ));
  subscription.trend = Array.from(subscriptionTrendMap.values())
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    today,
    thisWeek,
    thisMonth,
    perVendor: Array.from(perVendorMap.values()).sort((a, b) => b.cost - a.cost),
    perModel: Array.from(perModelMap.values()).sort((a, b) => b.cost - a.cost),
    trend,
    topConversations,
    subscription,
    generatedAt: now.toISOString(),
  };
}

const DEFAULT_USAGE_SUMMARY_CACHE_ENTRIES = 24;

type CachedUsageSummary = Omit<UsageSummary, "generatedAt">;

interface UsageSummaryCacheLoad {
  summary: UsageSummary;
  /** Do not retain a summary if the audit snapshot changed while it was read. */
  cacheable: boolean;
  /** Retry only when the audit revision moved while this request was reading. */
  retryable?: boolean;
}

export interface UsageSummaryCache {
  get(key: string, now: Date): UsageSummary | undefined;
  store(key: string, summary: UsageSummary, now: Date): UsageSummary;
  getOrCompute(params: {
    key: string;
    now: Date;
    compute: () => Promise<UsageSummaryCacheLoad>;
  }): Promise<UsageSummary>;
}

function toCachedUsageSummary(summary: UsageSummary): CachedUsageSummary {
  const { generatedAt: _generatedAt, ...payload } = summary;
  return structuredClone(payload);
}

function cloneCachedUsageSummary(
  summary: CachedUsageSummary,
  now: Date,
): UsageSummary {
  return {
    ...structuredClone(summary),
    generatedAt: now.toISOString(),
  };
}

/**
 * A bounded LRU for immutable usage aggregates. The caller owns the revision
 * key so audit mutations, calendar boundaries, and price changes never reuse
 * a stale summary.
 */
export function createUsageSummaryCache(
  options: { maxEntries?: number } = {},
): UsageSummaryCache {
  const maxEntries = options.maxEntries ?? DEFAULT_USAGE_SUMMARY_CACHE_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("Usage summary cache maxEntries must be a positive integer");
  }

  const entries = new Map<string, CachedUsageSummary>();
  const get = (key: string, now: Date): UsageSummary | undefined => {
    const cached = entries.get(key);
    if (!cached) return undefined;
    // Moving the hit to the back preserves least-recently-used eviction.
    entries.delete(key);
    entries.set(key, cached);
    return cloneCachedUsageSummary(cached, now);
  };
  const store = (
    key: string,
    summary: UsageSummary,
    now: Date,
  ): UsageSummary => {
    const cachedSummary = toCachedUsageSummary(summary);
    entries.set(key, cachedSummary);
    while (entries.size > maxEntries) {
      const leastRecentlyUsed = entries.keys().next().value;
      if (leastRecentlyUsed === undefined) break;
      entries.delete(leastRecentlyUsed);
    }
    // Return a clone so callers cannot mutate the value we retained.
    return cloneCachedUsageSummary(cachedSummary, now);
  };

  return {
    get,
    store,
    async getOrCompute({ key, now, compute }): Promise<UsageSummary> {
      const cached = get(key, now);
      if (cached) return cached;

      const loaded = await compute();
      if (loaded.cacheable) return store(key, loaded.summary, now);
      return cloneCachedUsageSummary(
        toCachedUsageSummary(loaded.summary),
        now,
      );
    },
  };
}

const usageSummaryCache = createUsageSummaryCache();

type UsageSummaryCacheQuery =
  | { kind: "range"; dateFrom: string; dateTo: string }
  | { kind: "rolling"; days: number };

function createUsageSummaryCacheKey(params: {
  auditDir: string;
  query: UsageSummaryCacheQuery;
  now: Date;
  pricingOverrides: readonly PricingOverride[];
  manifest: readonly UsageAuditFileManifest[];
}): string {
  return JSON.stringify({
    version: 1,
    auditDir: params.auditDir,
    query: params.query,
    localDate: localDateKey(params.now),
    pricingOverride: pricingOverridesSignature(params.pricingOverrides),
    manifest: params.manifest,
  });
}

function manifestsMatch(
  left: readonly UsageAuditFileManifest[],
  right: readonly UsageAuditFileManifest[],
): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index];
    return (
      file.name === other.name
      && file.size === other.size
      && file.mtimeMs === other.mtimeMs
      && file.ctimeMs === other.ctimeMs
    );
  });
}

interface CachedUsageSummaryRequest {
  auditDir: string;
  query: UsageSummaryCacheQuery;
  now: Date;
  matchesFile: (file: UsageAuditFile) => boolean;
  matchesEntry: (entry: AuditTurnEntry) => boolean;
  pricingOverrides: readonly PricingOverride[];
}

async function loadUsageSummaryFromSnapshot(
  request: CachedUsageSummaryRequest,
  before: UsageAuditSnapshot,
): Promise<UsageSummaryCacheLoad> {
  const read = await readUsageAuditEntriesWithStatus(
    request.auditDir,
    before.files,
    request.matchesEntry,
  );
  const after = await snapshotUsageAuditFiles(
    request.auditDir,
    request.matchesFile,
  );
  const manifestStable = (
    before.complete
    && after.complete
    && manifestsMatch(before.manifest, after.manifest)
  );
  return {
    summary: computeUsageSummary(read.entries, request.now, request.pricingOverrides),
    cacheable: manifestStable && read.complete,
    // A stable corrupt or unreadable file must stay uncached, but retrying it
    // immediately only repeats the same failed stream work.
    retryable: !manifestStable,
  };
}

async function getCachedUsageSummary(
  request: CachedUsageSummaryRequest,
): Promise<UsageSummary> {
  return withAuditSnapshotLock(
    request.auditDir,
    async () => {
      // Rotation shares this lock. Active appends use per-file locks, so a
      // cache hit validates the manifest again before it can be returned.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await snapshotUsageAuditFiles(
          request.auditDir,
          request.matchesFile,
        );
        const compute = () => loadUsageSummaryFromSnapshot(request, before);

        if (!before.complete) {
          const loaded = await compute();
          return cloneCachedUsageSummary(
            toCachedUsageSummary(loaded.summary),
            request.now,
          );
        }

        const key = createUsageSummaryCacheKey({
          auditDir: request.auditDir,
          query: request.query,
          now: request.now,
          pricingOverrides: request.pricingOverrides,
          manifest: before.manifest,
        });
        const cached = usageSummaryCache.get(key, request.now);
        if (cached) {
          const after = await snapshotUsageAuditFiles(
            request.auditDir,
            request.matchesFile,
          );
          if (after.complete && manifestsMatch(before.manifest, after.manifest)) {
            return cached;
          }
          continue;
        }

        const loaded = await compute();
        if (loaded.cacheable) {
          return usageSummaryCache.store(key, loaded.summary, request.now);
        }
        if (!loaded.retryable) {
          return cloneCachedUsageSummary(
            toCachedUsageSummary(loaded.summary),
            request.now,
          );
        }
      }

      // A continuously-appending file should still return a fresh best-effort
      // view, but it must not leave an unstable revision in the cache.
      const before = await snapshotUsageAuditFiles(
        request.auditDir,
        request.matchesFile,
      );
      const loaded = await loadUsageSummaryFromSnapshot(request, before);
      return cloneCachedUsageSummary(
        toCachedUsageSummary(loaded.summary),
        request.now,
      );
    },
  );
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
  pricingOverrides: readonly PricingOverride[] = [],
): Promise<UsageSummary> {
  const auditDir = join(lvisHome(), "audit");
  const fileDateFrom = shiftLocalDateKey(opts.dateFrom, -1);
  const fileDateTo = shiftLocalDateKey(opts.dateTo, 1);

  return getCachedUsageSummary({
    auditDir,
    query: {
      kind: "range",
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
    },
    now,
    matchesFile: (file) => (
      file.date >= fileDateFrom && file.date <= fileDateTo
    ),
    matchesEntry: (entry) => {
      const timestamp = new Date(entry.timestamp);
      if (Number.isNaN(timestamp.getTime())) return false;
      const date = localDateKey(timestamp);
      return date >= opts.dateFrom && date <= opts.dateTo;
    },
    pricingOverrides,
  });
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
  pricingOverrides: readonly PricingOverride[] = [],
): Promise<UsageSummary> {
  const auditDir = join(lvisHome(), "audit");
  const cutoffDateKey = shiftLocalDateKey(localDateKey(now), -days);
  const cutoffFileKey = shiftLocalDateKey(cutoffDateKey, -1);

  return getCachedUsageSummary({
    auditDir,
    query: { kind: "rolling", days },
    now,
    matchesFile: (file) => file.date >= cutoffFileKey,
    matchesEntry: (entry) => {
      const timestamp = new Date(entry.timestamp);
      return !Number.isNaN(timestamp.getTime()) && localDateKey(timestamp) >= cutoffDateKey;
    },
    pricingOverrides,
  });
}
