/**
 * Q12 Phase 3 — VerdictCache unit tests.
 *
 * Coverage:
 *   - canonicalInputShape: shape ≠ literal (cache shared by shape)
 *   - lookup: miss-not-found / miss-expired / miss-stale / hit
 *   - store + lookup round-trip
 *   - invalidateMismatching drops only stale-context entries
 *   - HIGH verdicts are cached too
 *   - Persistence to file across instances
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VerdictCache,
  canonicalInputShape,
  computeCacheKey,
  computeInvalidationKey,
  type VerdictCacheLookupKey,
  type VerdictCacheContext,
} from "../reviewer/verdict-cache.js";
import type { RiskVerdict } from "../reviewer/risk-classifier.js";

function tmpCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-verdict-cache-"));
  return join(dir, "reviewer-cache.jsonl");
}

const CTX: VerdictCacheContext = {
  allowedDirectories: ["/Users/ken/work", "/Users/ken/.lvis"],
  scope: { mode: "deny-all" },
};

const LOOKUP: VerdictCacheLookupKey = {
  toolName: "fs_write",
  source: "builtin",
  category: "write",
  trustOrigin: "user",
  finalInput: { path: "/Users/ken/work/a.md", count: 5 },
};

describe("canonicalInputShape", () => {
  it("replaces values with type names", () => {
    expect(canonicalInputShape({ path: "/a", count: 5 })).toBe(
      `{"count":"number","path":"string"}`,
    );
  });

  it("keys are deep-sorted", () => {
    const a = canonicalInputShape({ z: 1, a: 2 });
    const b = canonicalInputShape({ a: 2, z: 1 });
    expect(a).toBe(b);
  });

  it("array element types preserved per index", () => {
    expect(canonicalInputShape({ items: [1, "two", null] })).toBe(
      `{"items":["number","string","null"]}`,
    );
  });

  it("two paths with same shape produce same string", () => {
    const a = canonicalInputShape({ path: "/a/b/c.md" });
    const b = canonicalInputShape({ path: "/etc/passwd" });
    expect(a).toBe(b);
  });
});

describe("computeCacheKey", () => {
  it("same input shape, different literal → same key", () => {
    const k1 = computeCacheKey({
      ...LOOKUP,
      finalInput: { path: "/Users/ken/work/x.md", count: 1 },
    });
    const k2 = computeCacheKey({
      ...LOOKUP,
      finalInput: { path: "/etc/passwd", count: 999 },
    });
    expect(k1).toBe(k2);
  });

  it("different category → different key", () => {
    const k1 = computeCacheKey(LOOKUP);
    const k2 = computeCacheKey({ ...LOOKUP, category: "read" });
    expect(k1).not.toBe(k2);
  });

  it("different toolName → different key", () => {
    const k1 = computeCacheKey(LOOKUP);
    const k2 = computeCacheKey({ ...LOOKUP, toolName: "other" });
    expect(k1).not.toBe(k2);
  });

  it("different trustOrigin → different key (architect round-4: high-trust verdict must not be served to low-trust origin)", () => {
    const userKey = computeCacheKey({ ...LOOKUP, trustOrigin: "user" });
    const agentKey = computeCacheKey({ ...LOOKUP, trustOrigin: "agent" });
    const pluginKey = computeCacheKey({ ...LOOKUP, trustOrigin: "plugin" });
    expect(userKey).not.toBe(agentKey);
    expect(userKey).not.toBe(pluginKey);
    expect(agentKey).not.toBe(pluginKey);
  });
});

describe("computeInvalidationKey", () => {
  it("dirs in different order produce same key", () => {
    const a = computeInvalidationKey({ ...CTX, allowedDirectories: ["/a", "/b"] });
    const b = computeInvalidationKey({ ...CTX, allowedDirectories: ["/b", "/a"] });
    expect(a).toBe(b);
  });

  it("scope object key order doesn't change result", () => {
    const a = computeInvalidationKey({ ...CTX, scope: { x: 1, y: 2 } });
    const b = computeInvalidationKey({ ...CTX, scope: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it("changing dirs changes key", () => {
    const a = computeInvalidationKey({ ...CTX, allowedDirectories: ["/a"] });
    const b = computeInvalidationKey({ ...CTX, allowedDirectories: ["/a", "/b"] });
    expect(a).not.toBe(b);
  });
});

describe("VerdictCache lookup states", () => {
  let cache: VerdictCache;
  let path: string;

  beforeEach(() => {
    path = tmpCachePath();
    cache = new VerdictCache(path);
  });

  it("returns miss-not-found for empty cache", () => {
    const r = cache.lookup(LOOKUP, CTX);
    expect(r.hit).toBe(false);
    expect(r.reason).toBe("miss-not-found");
  });

  it("hit after store", async () => {
    const verdict: RiskVerdict = { level: "low", reason: "ok" };
    await cache.store(LOOKUP, CTX, verdict);
    const r = cache.lookup(LOOKUP, CTX);
    expect(r.hit).toBe(true);
    expect(r.verdict).toEqual(verdict);
    expect(r.reason).toBe("hit");
  });

  it("HIGH verdict is cached too (re-deny is fast)", async () => {
    const verdict: RiskVerdict = { level: "high", reason: "obviously bad" };
    await cache.store(LOOKUP, CTX, verdict);
    const r = cache.lookup(LOOKUP, CTX);
    expect(r.hit).toBe(true);
    expect(r.verdict?.level).toBe("high");
  });

  it("miss-stale when invalidationKey doesn't match", async () => {
    const verdict: RiskVerdict = { level: "low", reason: "ok" };
    await cache.store(LOOKUP, CTX, verdict);
    const newCtx: VerdictCacheContext = {
      allowedDirectories: ["/different/path"],
      scope: { mode: "deny-all" },
    };
    const r = cache.lookup(LOOKUP, newCtx);
    expect(r.hit).toBe(false);
    expect(r.reason).toBe("miss-stale");
  });

  it("miss-expired when expiresAt < now", () => {
    const expired = JSON.stringify({
      key: computeCacheKey(LOOKUP),
      verdict: { level: "low", reason: "ok" },
      expiresAt: Date.now() - 1000,
      invalidationKey: computeInvalidationKey(CTX),
    });
    writeFileSync(path, expired + "\n", "utf-8");
    cache = new VerdictCache(path);
    const r = cache.lookup(LOOKUP, CTX);
    expect(r.hit).toBe(false);
    expect(r.reason).toBe("miss-expired");
  });
});

describe("VerdictCache persistence", () => {
  it("entry survives across cache instances", async () => {
    const path = tmpCachePath();
    const a = new VerdictCache(path);
    await a.store(LOOKUP, CTX, { level: "medium", reason: "x" });
    const b = new VerdictCache(path);
    const r = b.lookup(LOOKUP, CTX);
    expect(r.hit).toBe(true);
    expect(r.verdict?.level).toBe("medium");
  });

  it("file format is JSONL", async () => {
    const path = tmpCachePath();
    const cache = new VerdictCache(path);
    await cache.store(LOOKUP, CTX, { level: "low", reason: "a" });
    await cache.store({ ...LOOKUP, toolName: "other" }, CTX, { level: "high", reason: "b" });
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("key");
      expect(parsed).toHaveProperty("verdict");
      expect(parsed).toHaveProperty("expiresAt");
      expect(parsed).toHaveProperty("invalidationKey");
    }
  });
});

describe("VerdictCache invalidateMismatching (selective by invalidationKey)", () => {
  it("drops only entries with mismatching invalidationKey", async () => {
    const path = tmpCachePath();
    const cache = new VerdictCache(path);
    const ctxA: VerdictCacheContext = {
      allowedDirectories: ["/A"],
      scope: { mode: "deny-all" },
    };
    const ctxB: VerdictCacheContext = {
      allowedDirectories: ["/B"],
      scope: { mode: "deny-all" },
    };
    await cache.store({ ...LOOKUP, toolName: "ta" }, ctxA, { level: "low", reason: "a" });
    await cache.store({ ...LOOKUP, toolName: "tb" }, ctxB, { level: "low", reason: "b" });

    // Now context becomes ctxA — only ta should remain.
    const dropped = await cache.invalidateMismatching(ctxA);
    expect(dropped).toBe(1);

    expect(cache.lookup({ ...LOOKUP, toolName: "ta" }, ctxA).hit).toBe(true);
    // tb's entry was for ctxB; under ctxA it was stale → invalidated.
    expect(cache.lookup({ ...LOOKUP, toolName: "tb" }, ctxA).hit).toBe(false);
  });

  it("returns 0 when no entries are stale", async () => {
    const path = tmpCachePath();
    const cache = new VerdictCache(path);
    await cache.store(LOOKUP, CTX, { level: "low", reason: "a" });
    const dropped = await cache.invalidateMismatching(CTX);
    expect(dropped).toBe(0);
    expect(cache.lookup(LOOKUP, CTX).hit).toBe(true);
  });

  it("settings change invalidates only mismatching entries (cache integrity)", async () => {
    const path = tmpCachePath();
    const cache = new VerdictCache(path);
    const old: VerdictCacheContext = {
      allowedDirectories: ["/old"],
      scope: { x: 1 },
    };
    const updated: VerdictCacheContext = {
      allowedDirectories: ["/old", "/new"],
      scope: { x: 1 },
    };
    // Two entries — one under old, one already under updated.
    await cache.store({ ...LOOKUP, toolName: "stale" }, old, { level: "low", reason: "x" });
    await cache.store({ ...LOOKUP, toolName: "current" }, updated, {
      level: "medium",
      reason: "y",
    });

    const dropped = await cache.invalidateMismatching(updated);
    expect(dropped).toBe(1);
    // The "current" entry still hits.
    expect(cache.lookup({ ...LOOKUP, toolName: "current" }, updated).hit).toBe(true);
    // The "stale" entry is gone.
    expect(cache.lookup({ ...LOOKUP, toolName: "stale" }, updated).hit).toBe(false);
  });
});
