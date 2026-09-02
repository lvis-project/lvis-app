/**
 * Permission policy — Layer 5 Reviewer Agent: verdict cache.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5
 * verdict cache, §11 v2.1 binding decision (selective by invalidationKey).
 *
 * Storage: `~/.lvis/permissions/reviewer-cache.jsonl` (append-only,
 * per-feature namespace per CLAUDE.md storage rule).
 *
 * Cache key: sha256Hex(toolName + source + category + trustOrigin +
 * approvalCacheKey + canonicalInputIdentity + conversationContext +
 * toolPolicyIdentity).
 *   - canonicalInputShape replaces every value with its type-name and
 *     deep-sorts keys for categories whose deterministic reviewer rules
 *     do not inspect literal values.
 *   - shell/network/read/write are value-sensitive: command literals,
 *     hosts, and target paths drive the deterministic risk classifier, so
 *     those keys use sorted literal JSON.
 *
 * invalidationKey: sha256Hex(allowedDirectories.sorted ‖ scope.json.sorted ‖
 * sandboxWrapState.json.sorted).
 *   - When settings change (additionalDirectories, scope) the cached
 *     entries with stale invalidationKey are dropped on next read.
 *   - When ASRT reviewer relaxation depends on a long-lived worker being
 *     wrapped, that worker's live wrap marker is part of the key. A relaxed
 *     verdict therefore cannot outlive the confinement that justified it.
 *     Cold-start hit rate is preserved for entries whose context is
 *     still valid.
 *
 * TTL: 24h. HIGH verdicts cached too (avoid re-classify obvious
 * dangers — caching ≠ fallback per v2 code-reviewer m2).
 *
 * NOT a circuit breaker: provider quota exhaustion routes through
 * `fallbackOnError` (rule | deny), NOT through cache.
 */
import { resolve as pathResolve } from "node:path";
import type { RiskVerdict } from "./risk-classifier.js";
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../../tools/types.js";
import { JsonlRecordFile } from "../../audit/jsonl-reader.js";
import { createLogger } from "../../lib/logger.js";
import { lvisHome } from "../../shared/lvis-home.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

const log = createLogger("reviewer-cache");

const TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_VERDICT_CACHE_ENTRIES = 500;

export interface VerdictCacheEntry {
  /** sha256Hex(toolName+source+category+trustOrigin+approvalCacheKey+canonicalInputIdentity) */
  key: string;
  verdict: RiskVerdict;
  /** Unix ms, expiresAt = createdAt + TTL_MS */
  expiresAt: number;
  /** sha256 over (allowedDirectories sorted, scope JSON sorted). */
  invalidationKey: string;
}

export interface VerdictCacheLookupKey {
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  /**
   * Permission policy architect round-4: cache identity must include trust origin.
   * A `user-keyboard` verdict cached for a write must NOT be served to
   * an `llm-tool-arg` invocation of the same shape — the underlying
   * intent (and therefore the safe verdict) differs.
   */
  trustOrigin: ToolTrustOrigin;
  approvalCacheKey?: string;
  conversationContext?: {
    recentUserMessage?: string;
  };
  pathFields?: readonly string[];
  ownerPluginSandboxRoot?: string;
  mcpServerId?: string;
  pluginId?: string;
  workerId?: string;
  finalInput: Record<string, unknown>;
}

export interface VerdictCacheContext {
  allowedDirectories: string[];
  /** Free-form scope object (RoutineScope or `{}` for non-routine paths). */
  scope: Record<string, unknown>;
  /**
   * Live sandbox substrate marker for reviewer invalidation. This is separate
   * from `scope` because routine/settings scope changes and long-lived-worker
   * wrap/un-wrap changes are different invalidation axes.
   */
  sandboxWrapState?: unknown;
}

function defaultPath(): string {
  return pathResolve(lvisHome(), "permissions", "reviewer-cache.jsonl");
}

// ─── Canonical-shape derivation ──────────────────────────────────────

/**
 * Replace every leaf with its type-name and deep-sort keys. The
 * resulting JSON string is the cache identity for inputs.
 *
 *   { path: "/a/b", count: 5 }
 *     → '{"count":"number","path":"string"}'
 *
 *   { items: [1, "two", null] }
 *     → '{"items":["number","string","null"]}'
 */
export function canonicalInputShape(input: Record<string, unknown>): string {
  return JSON.stringify(shapeOf(input));
}

function canonicalInputValue(input: Record<string, unknown>): string {
  return JSON.stringify(input, sortedReplacer);
}

function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.map(shapeOf);
  switch (typeof v) {
    case "object": {
      const obj = v as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const out: Record<string, unknown> = {};
      for (const k of sortedKeys) out[k] = shapeOf(obj[k]);
      return out;
    }
    case "string":
    case "number":
    case "boolean":
    case "undefined":
      return typeof v;
    default:
      return "unknown";
  }
}

// ─── Hash helpers ────────────────────────────────────────────────────

export function computeCacheKey(lookup: VerdictCacheLookupKey): string {
  const shape = isValueSensitiveCategory(lookup.category)
    ? canonicalInputValue(lookup.finalInput)
    : canonicalInputShape(lookup.finalInput);
  const conversationContext = canonicalInputValue({
    conversationContext: lookup.conversationContext ?? null,
  });
  // #885 v6 (§5.4): `writesToOwnSandbox` REMOVED from the hashed identity. This
  // shrinks the canonical JSON of EVERY entry, so sha256Hex(new) ≠ sha256Hex(old) for
  // all keys — the pre-migration on-disk cache becomes unreachable (mass
  // re-classify on first lookup, never a stale HIT that could replay an old
  // dead-rule verdict). `ownerPluginSandboxRoot` STAYS — the auto-LOW now DEPENDS
  // on it, so a plugin rename/reinstall must (and does) invalidate a cached LOW.
  const toolPolicyIdentity = canonicalInputValue({
    pathFields: lookup.pathFields ?? null,
    ownerPluginSandboxRoot: lookup.ownerPluginSandboxRoot ?? null,
    mcpServerId: lookup.mcpServerId ?? null,
    pluginId: lookup.pluginId ?? null,
    workerId: lookup.workerId ?? null,
  });
  return sha256Hex(`${lookup.toolName}\x1f${lookup.source}\x1f${lookup.category}\x1f${lookup.trustOrigin}\x1f${lookup.approvalCacheKey ?? ""}\x1f${shape}\x1f${conversationContext}\x1f${toolPolicyIdentity}`);
}

function isValueSensitiveCategory(category: ToolCategory): boolean {
  return category === "shell" || category === "network" || category === "write" || category === "read";
}

export function computeInvalidationKey(ctx: VerdictCacheContext): string {
  const dirs = [...ctx.allowedDirectories].sort();
  const scopeJson = JSON.stringify(ctx.scope, sortedReplacer);
  const sandboxWrapJson = JSON.stringify(ctx.sandboxWrapState ?? null, sortedReplacer);
  return sha256Hex(`${JSON.stringify(dirs)}\x1f${scopeJson}\x1f${sandboxWrapJson}`);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

// ─── Cache implementation ────────────────────────────────────────────

export interface VerdictCacheLookupResult {
  hit: boolean;
  verdict?: RiskVerdict;
  /** Why a hit/miss happened — useful for audit-trail "from cache" hint. */
  reason: "hit" | "miss-stale" | "miss-expired" | "miss-not-found";
}

export class VerdictCache {
  private readonly file: JsonlRecordFile<VerdictCacheEntry>;
  /** In-memory mirror of the file. Loaded lazily on first read. */
  private entries: VerdictCacheEntry[] | null = null;
  /** Best-effort rewrites scheduled by synchronous lookup pruning. */
  private readonly pendingRewrites = new Set<Promise<void>>();

  constructor(filePath?: string) {
    this.file = new JsonlRecordFile<VerdictCacheEntry>(filePath ?? defaultPath(), {
      accept: (parsed): parsed is VerdictCacheEntry => {
        const entry = parsed as Partial<VerdictCacheEntry> | null;
        return Boolean(
          entry &&
          typeof entry.key === "string" &&
          typeof entry.invalidationKey === "string" &&
          entry.verdict &&
          typeof entry.expiresAt === "number",
        );
      },
      // A malformed line is dropped, not fatal: the cache file is
      // non-authoritative scratch storage, and the next write produces a
      // clean record.
      onMalformedLine: (line) => log.warn(`skipping malformed cache line: ${line.trim().slice(0, 80)}`),
      onReadFailure: (err) => log.warn(`failed to read cache: %s`, (err as Error).message),
    });
  }

  /**
   * Ensure the in-memory mirror is populated. Reads the JSONL file once
   * per cache instance (subsequent calls are no-op when entries !== null).
   * Tests call resetForTests() to force a re-read.
   */
  private ensureLoaded(): void {
    if (this.entries !== null) return;
    this.entries = this.file.loadSync();
  }

  /**
   * Look up a verdict. Returns:
   *   - hit:true + verdict   — entry matches key + invalidationKey + not expired
   *   - hit:false miss-stale  — entry found but invalidationKey doesn't match
   *   - hit:false miss-expired — entry found but expired
   *   - hit:false miss-not-found
   */
  lookup(
    lookup: VerdictCacheLookupKey,
    ctx: VerdictCacheContext,
  ): VerdictCacheLookupResult {
    this.ensureLoaded();
    const key = computeCacheKey(lookup);
    const ivk = computeInvalidationKey(ctx);
    const now = Date.now();
    let pruned = false;
    let missReason: VerdictCacheLookupResult["reason"] | null = null;
    // Iterate newest-last so latest-write wins on duplicates.
    for (let i = this.entries!.length - 1; i >= 0; i--) {
      const entry = this.entries![i];
      if (entry.key !== key) continue;
      if (entry.invalidationKey !== ivk) {
        this.entries!.splice(i, 1);
        pruned = true;
        missReason ??= "miss-stale";
        continue;
      }
      if (entry.expiresAt < now) {
        this.entries!.splice(i, 1);
        pruned = true;
        missReason ??= "miss-expired";
        continue;
      }
      if (pruned) this.scheduleRewrite();
      return { hit: true, verdict: entry.verdict, reason: "hit" };
    }
    if (pruned) this.scheduleRewrite();
    return { hit: false, reason: missReason ?? "miss-not-found" };
  }

  /**
   * Store a verdict. Appends to file + in-memory. Caller is expected to
   * have already classified — store() does not validate verdict.
   */
  async store(
    lookup: VerdictCacheLookupKey,
    ctx: VerdictCacheContext,
    verdict: RiskVerdict,
  ): Promise<void> {
    this.ensureLoaded();
    const entry: VerdictCacheEntry = {
      key: computeCacheKey(lookup),
      verdict,
      expiresAt: Date.now() + TTL_MS,
      invalidationKey: computeInvalidationKey(ctx),
    };
    this.entries!.push(entry);
    const pruned = this.pruneExpiredAndCap(Date.now());
    if (pruned) {
      await this.file.rewrite(this.entries!);
    } else {
      await this.file.append(entry);
    }
  }

  /**
   * Walk cache file and drop entries whose invalidationKey doesn't
   * match the current context. Called when settings change.
   *
   * Returns the count of dropped entries (for audit/UX).
   */
  async invalidateMismatching(currentCtx: VerdictCacheContext): Promise<number> {
    this.ensureLoaded();
    const ivk = computeInvalidationKey(currentCtx);
    const before = this.entries!.length;
    this.entries = this.entries!.filter((e) => e.invalidationKey === ivk);
    const dropped = before - this.entries!.length;
    if (dropped > 0) {
      await this.file.rewrite(this.entries!);
    }
    return dropped;
  }

  /**
   * Wait for background rewrites scheduled by lookup pruning to finish.
   *
   * Lookup stays synchronous, so stale and expired entries are rewritten on a
   * best-effort background path. Lifecycle owners can await this boundary
   * before removing the cache directory or otherwise retiring the instance.
   */
  async flush(): Promise<void> {
    while (this.pendingRewrites.size > 0) {
      await Promise.all([...this.pendingRewrites]);
    }
  }

  /** Reset in-memory mirror (test helper). */
  resetForTests(): void {
    this.entries = null;
  }

  private pruneExpiredAndCap(now: number): boolean {
    const before = this.entries!.length;
    this.entries = this.entries!.filter((entry) => entry.expiresAt >= now);
    if (this.entries.length > MAX_VERDICT_CACHE_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_VERDICT_CACHE_ENTRIES);
    }
    return this.entries.length !== before;
  }

  private scheduleRewrite(): void {
    let pending: Promise<void>;
    pending = this.file.rewrite(this.entries!)
      .catch((err) => {
        log.warn(`failed to rewrite pruned cache: %s`, (err as Error).message);
      })
      .finally(() => {
        this.pendingRewrites.delete(pending);
      });
    this.pendingRewrites.add(pending);
  }
}
