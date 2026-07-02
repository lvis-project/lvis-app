/**
 * Permission policy — Layer 5 Reviewer Agent: verdict cache.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5
 * verdict cache, §11 v2.1 binding decision (selective by invalidationKey).
 *
 * Storage: `~/.lvis/permissions/reviewer-cache.jsonl` (append-only,
 * per-feature namespace per CLAUDE.md storage rule).
 *
 * Cache key: sha256(toolName + source + category + trustOrigin +
 * approvalCacheKey + canonicalInputIdentity + conversationContext +
 * toolPolicyIdentity).
 *   - canonicalInputShape replaces every value with its type-name and
 *     deep-sorts keys for categories whose deterministic reviewer rules
 *     do not inspect literal values.
 *   - shell/network/read/write are value-sensitive: command literals,
 *     hosts, and target paths drive the deterministic risk classifier, so
 *     those keys use sorted literal JSON.
 *
 * invalidationKey: sha256(allowedDirectories.sorted ‖ scope.json.sorted).
 *   - When settings change (additionalDirectories, scope) the cached
 *     entries with stale invalidationKey are dropped on next read.
 *     Cold-start hit rate is preserved for entries whose context is
 *     still valid.
 *
 * TTL: 24h. HIGH verdicts cached too (avoid re-classify obvious
 * dangers — caching ≠ fallback per v2 code-reviewer m2).
 *
 * NOT a circuit breaker: provider quota exhaustion routes through
 * `fallbackOnError` (rule | deny), NOT through cache.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { createHash } from "node:crypto";
import type { RiskVerdict } from "./risk-classifier.js";
import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../../tools/types.js";
import { withFileLock } from "../../lib/with-file-lock.js";
import { createLogger } from "../../lib/logger.js";
import { lvisHome } from "../../shared/lvis-home.js";

const log = createLogger("reviewer-cache");

const TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_VERDICT_CACHE_ENTRIES = 500;

export interface VerdictCacheEntry {
  /** sha256(toolName+source+category+trustOrigin+approvalCacheKey+canonicalInputIdentity) */
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
  writesToOwnSandbox?: boolean;
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function computeCacheKey(lookup: VerdictCacheLookupKey): string {
  const shape = isValueSensitiveCategory(lookup.category)
    ? canonicalInputValue(lookup.finalInput)
    : canonicalInputShape(lookup.finalInput);
  const conversationContext = canonicalInputValue({
    conversationContext: lookup.conversationContext ?? null,
  });
  const toolPolicyIdentity = canonicalInputValue({
    pathFields: lookup.pathFields ?? null,
    writesToOwnSandbox: lookup.writesToOwnSandbox ?? null,
    ownerPluginSandboxRoot: lookup.ownerPluginSandboxRoot ?? null,
    mcpServerId: lookup.mcpServerId ?? null,
    pluginId: lookup.pluginId ?? null,
    workerId: lookup.workerId ?? null,
  });
  return sha256(`${lookup.toolName}\x1f${lookup.source}\x1f${lookup.category}\x1f${lookup.trustOrigin}\x1f${lookup.approvalCacheKey ?? ""}\x1f${shape}\x1f${conversationContext}\x1f${toolPolicyIdentity}`);
}

function isValueSensitiveCategory(category: ToolCategory): boolean {
  return category === "shell" || category === "network" || category === "write" || category === "read";
}

export function computeInvalidationKey(ctx: VerdictCacheContext): string {
  const dirs = [...ctx.allowedDirectories].sort();
  const scopeJson = JSON.stringify(ctx.scope, sortedReplacer);
  return sha256(`${JSON.stringify(dirs)}\x1f${scopeJson}`);
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
  private readonly filePath: string;
  /** In-memory mirror of the file. Loaded lazily on first read. */
  private entries: VerdictCacheEntry[] | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultPath();
  }

  /**
   * Ensure the in-memory mirror is populated. Reads the JSONL file once
   * per cache instance (subsequent calls are no-op when entries !== null).
   * Tests call resetForTests() to force a re-read.
   */
  private ensureLoaded(): void {
    if (this.entries !== null) return;
    if (!existsSync(this.filePath)) {
      this.entries = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const out: VerdictCacheEntry[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as VerdictCacheEntry;
          if (
            typeof parsed.key === "string" &&
            typeof parsed.invalidationKey === "string" &&
            parsed.verdict &&
            typeof parsed.expiresAt === "number"
          ) {
            out.push(parsed);
          }
        } catch {
          // Skip malformed lines — log and continue. Atomic cutover
          // (CLAUDE.md No-Fallback) does NOT apply here: the cache
          // file is non-authoritative scratch storage; a corrupt line
          // is dropped and the next write produces a clean record.
          log.warn(`skipping malformed cache line: ${trimmed.slice(0, 80)}`);
        }
      }
      this.entries = out;
    } catch (err) {
      log.warn(`failed to read cache: %s`, (err as Error).message);
      this.entries = [];
    }
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
      await this.rewriteFromMemory();
    } else {
      await this.appendLine(entry);
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
      await this.rewriteFromMemory();
    }
    return dropped;
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
    void this.rewriteFromMemory().catch((err) => {
      log.warn(`failed to rewrite pruned cache: %s`, (err as Error).message);
    });
  }

  private async appendLine(entry: VerdictCacheEntry): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.filePath, line, { encoding: "utf-8", mode: 0o600 });
    });
  }

  private async rewriteFromMemory(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const body = this.entries!.map((e) => JSON.stringify(e)).join("\n") + (this.entries!.length > 0 ? "\n" : "");
      writeFileSync(this.filePath, body, { encoding: "utf-8", mode: 0o600 });
    });
  }
}
