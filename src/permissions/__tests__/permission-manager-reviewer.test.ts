/**
 * Q12 Phase 3 — PermissionManager.dispatchReviewer + setReviewer wiring.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../permission-manager.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import {
  RuleBasedRiskClassifier,
  type RiskClassifier,
  type ToolInvocationContext,
  type RiskVerdict,
} from "../reviewer/risk-classifier.js";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-pm-reviewer-"));
  return join(dir, name);
}

function makeManager(): {
  pm: PermissionManager;
  cache: VerdictCache;
  queue: DeferredQueue;
  classifier: RiskClassifier;
} {
  const pm = new PermissionManager(tmpFile("permissions.json"));
  const cache = new VerdictCache(tmpFile("reviewer-cache.jsonl"));
  const queue = new DeferredQueue(tmpFile("deferred-queue.jsonl"));
  const classifier = new RuleBasedRiskClassifier();
  pm.setReviewer({ classifier, cache, deferredQueue: queue });
  return { pm, cache, queue, classifier };
}

describe("PermissionManager.dispatchReviewer", () => {
  let pm: PermissionManager;
  let cache: VerdictCache;
  let queue: DeferredQueue;

  beforeEach(() => {
    ({ pm, cache, queue } = makeManager());
  });

  it("hasReviewer = false until setReviewer called", () => {
    const fresh = new PermissionManager(tmpFile("permissions.json"));
    expect(fresh.hasReviewer()).toBe(false);
  });

  it("hasReviewer = true after setReviewer", () => {
    expect(pm.hasReviewer()).toBe(true);
  });

  it("LOW verdict — no deferred entry, cacheReason='miss-not-found'", async () => {
    const r = await pm.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
    });
    expect(r.verdict.level).toBe("low");
    expect(r.deferredId).toBeUndefined();
    expect(r.cacheReason).toBe("miss-not-found");
  });

  it("HIGH verdict — deferred entry created with id", async () => {
    const r = await pm.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      finalInput: { path: "/etc/passwd" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
    });
    expect(r.verdict.level).toBe("high");
    expect(r.deferredId).toMatch(/^[0-9a-f-]{36}$/);
    const pending = queue.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(r.deferredId);
    expect(pending[0].toolName).toBe("fs_write");
  });

  it("MEDIUM verdict — no deferred entry", async () => {
    const r = await pm.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      finalInput: { path: "/Users/ken/work/a/b/c/d.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
    });
    expect(r.verdict.level).toBe("medium");
    expect(r.deferredId).toBeUndefined();
    expect(queue.listPending()).toHaveLength(0);
  });

  it("second dispatch hits cache", async () => {
    const input = {
      source: "builtin" as const,
      category: "write" as const,
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
    };
    const first = await pm.dispatchReviewer("fs_write", input);
    expect(first.cacheReason).toBe("miss-not-found");
    const second = await pm.dispatchReviewer("fs_write", input);
    expect(second.cacheReason).toBe("hit");
    expect(second.verdict).toEqual(first.verdict);
  });

  it("settings change invalidates stale cache (different allowedDirectories)", async () => {
    const ctxA = {
      source: "builtin" as const,
      category: "write" as const,
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
    };
    await pm.dispatchReviewer("fs_write", ctxA);
    // Same input, different allowedDirectories context.
    const ctxB = { ...ctxA, allowedDirectories: ["/different"] };
    const r = await pm.dispatchReviewer("fs_write", ctxB);
    expect(r.cacheReason).toBe("miss-stale");
  });

  it("returns HIGH + no deferredId when reviewer not wired", async () => {
    const fresh = new PermissionManager(tmpFile("permissions.json"));
    const r = await fresh.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      finalInput: { path: "/x" },
      allowedDirectories: [],
      sensitivePathsAdjacent: [],
    });
    expect(r.verdict.level).toBe("high");
    expect(r.verdict.reason).toMatch(/not wired/);
    expect(r.deferredId).toBeUndefined();
  });

  it("async classifier (LLM) is awaited", async () => {
    const asyncClassifier: RiskClassifier = {
      classify: vi.fn(
        async (_ctx: ToolInvocationContext): Promise<RiskVerdict> => ({
          level: "high",
          reason: "async high",
        }),
      ),
    };
    pm.setReviewer({ classifier: asyncClassifier, cache, deferredQueue: queue });
    const r = await pm.dispatchReviewer("any_tool", {
      source: "builtin",
      category: "write",
      finalInput: { path: "/x" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
    });
    expect(r.verdict.level).toBe("high");
    expect(r.verdict.reason).toBe("async high");
    expect(asyncClassifier.classify).toHaveBeenCalled();
  });
});

describe("PermissionManager.checkDetailed — headless mutating reviewer lane", () => {
  it("headless+write routes through the category reviewer lane", () => {
    const { pm } = makeManager();
    const result = pm.checkDetailed("any_write", "builtin", "write", null, {
      headless: true,
    });
    expect(result.decision).toBe("ask");
    expect(result.layer).toBe(6);
    expect(result.reason).toMatch(/reviewer agent/);
  });

  it("non-headless+write hits Layer 6 with category descriptor message", () => {
    const { pm } = makeManager();
    const result = pm.checkDetailed("any_write", "builtin", "write", null, {
      headless: false,
    });
    expect(result.decision).toBe("ask");
    expect(result.layer).toBe(6);
  });
});
