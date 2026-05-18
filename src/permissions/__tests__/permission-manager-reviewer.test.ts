/**
 * Permission policy Phase 3 — PermissionManager.dispatchReviewer + setReviewer wiring.
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
import { BashTool } from "../../tools/bash.js";

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
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });
    expect(r.verdict.level).toBe("low");
    expect(r.deferredId).toBeUndefined();
    expect(r.cacheReason).toBe("miss-not-found");
  });

  it("HIGH verdict — deferred entry created with id", async () => {
    const r = await pm.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/etc/passwd" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
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
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/a/b/c/d.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });
    expect(r.verdict.level).toBe("medium");
    expect(r.deferredId).toBeUndefined();
    expect(queue.listPending()).toHaveLength(0);
  });

  it("MEDIUM verdict — headless defer policy creates a queue entry", async () => {
    const r = await pm.dispatchReviewer(
      "fs_write",
      {
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        finalInput: { path: "/Users/ken/work/a/b/c/d.md" },
        allowedDirectories: ["/Users/ken/work"],
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg" as const,
      },
      undefined,
      { defer: "medium-high" },
    );
    expect(r.verdict.level).toBe("medium");
    expect(r.deferredId).toMatch(/^[0-9a-f-]{36}$/);
    const pending = queue.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].verdict.level).toBe("medium");
  });

  it("second dispatch hits cache", async () => {
    const input = {
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    const first = await pm.dispatchReviewer("fs_write", input);
    expect(first.cacheReason).toBe("miss-not-found");
    const second = await pm.dispatchReviewer("fs_write", input);
    expect(second.cacheReason).toBe("hit");
    expect(second.verdict).toEqual(first.verdict);
  });

  it("partitions reviewer cache by trustOrigin and approvalCacheKey", async () => {
    const classifier: RiskClassifier = {
      classify: vi.fn((_ctx: ToolInvocationContext): RiskVerdict => ({
        level: "low",
        reason: "classifier called",
      })),
    };
    pm.setReviewer({ classifier, cache, deferredQueue: queue });
    const base = {
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
    };

    const first = await pm.dispatchReviewer("fs_write", {
      ...base,
      trustOrigin: "user-keyboard" as const,
      approvalCacheKey: "fs_write:scope-a",
    });
    const same = await pm.dispatchReviewer("fs_write", {
      ...base,
      trustOrigin: "user-keyboard" as const,
      approvalCacheKey: "fs_write:scope-a",
    });
    const originChanged = await pm.dispatchReviewer("fs_write", {
      ...base,
      trustOrigin: "llm-tool-arg" as const,
      approvalCacheKey: "fs_write:scope-a",
    });
    const keyChanged = await pm.dispatchReviewer("fs_write", {
      ...base,
      trustOrigin: "llm-tool-arg" as const,
      approvalCacheKey: "fs_write:scope-b",
    });

    expect(first.cacheReason).toBe("miss-not-found");
    expect(same.cacheReason).toBe("hit");
    expect(originChanged.cacheReason).toBe("miss-not-found");
    expect(keyChanged.cacheReason).toBe("miss-not-found");
    expect(classifier.classify).toHaveBeenCalledTimes(3);
  });

  it("partitions reviewer cache by raw identity when redacted finalInput collides", async () => {
    const classifier: RiskClassifier = {
      classify: vi.fn((_ctx: ToolInvocationContext): RiskVerdict => ({
        level: "low",
        reason: "classifier called",
      })),
    };
    pm.setReviewer({ classifier, cache, deferredQueue: queue });
    const base = {
      source: "plugin" as const,
      category: "network" as const,
      pathFields: [],
      finalInput: { payload: "send ***@example.com with sk-****" },
      allowedDirectories: [],
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
    };

    const first = await pm.dispatchReviewer("plugin_send", {
      ...base,
      cacheIdentityInput: { payload: "send alice@example.com with sk-alice" },
    });
    const second = await pm.dispatchReviewer("plugin_send", {
      ...base,
      cacheIdentityInput: { payload: "send bob@example.com with sk-bob" },
    });
    const firstAgain = await pm.dispatchReviewer("plugin_send", {
      ...base,
      cacheIdentityInput: { payload: "send alice@example.com with sk-alice" },
    });

    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(firstAgain.cacheReason).toBe("hit");
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it("does not reuse reversible shell reviewer cache for destructive shell commands", async () => {
    const bash = new BashTool();
    const allowedDirectories = ["/Users/ken/work"];
    const firstInput = { command: "echo ok" };
    const destructiveInput = { command: "rm -rf ./build" };
    const first = await pm.dispatchReviewer("bash", {
      source: "builtin",
      category: "shell",
      pathFields: [],
      finalInput: firstInput,
      allowedDirectories,
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg",
      approvalCacheKey: `bash:${bash.approvalCacheKey(firstInput)}`,
    });
    const second = await pm.dispatchReviewer("bash", {
      source: "builtin",
      category: "shell",
      pathFields: [],
      finalInput: destructiveInput,
      allowedDirectories,
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg",
      approvalCacheKey: `bash:${bash.approvalCacheKey(destructiveInput)}`,
    });

    expect(first.verdict.level).toBe("low");
    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(second.verdict.level).toBe("high");
    expect(second.verdict.reason).toContain("destructive");
  });

  it("settings change invalidates stale cache (different allowedDirectories)", async () => {
    const ctxA = {
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    await pm.dispatchReviewer("fs_write", ctxA);
    // Same input, different allowedDirectories context.
    const ctxB = { ...ctxA, allowedDirectories: ["/different"] };
    const r = await pm.dispatchReviewer("fs_write", ctxB);
    expect(r.cacheReason).toBe("miss-stale");
  });

  it("reviewer cache is partitioned by reviewer wiring settings", async () => {
    const classifierA: RiskClassifier = {
      classify: vi.fn(() => ({ level: "low", reason: "classifier A" })),
    };
    const classifierB: RiskClassifier = {
      classify: vi.fn(() => ({ level: "medium", reason: "classifier B" })),
    };
    pm.setReviewer({
      classifier: classifierA,
      cache,
      deferredQueue: queue,
      cacheScope: { mode: "rule", model: "a" },
    });
    const input = {
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    const first = await pm.dispatchReviewer("fs_write", input);
    pm.setReviewer({
      classifier: classifierB,
      cache,
      deferredQueue: queue,
      cacheScope: { mode: "llm", model: "b" },
    });
    const second = await pm.dispatchReviewer("fs_write", input);

    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-stale");
    expect(second.verdict.reason).toBe("classifier B");
    expect(classifierB.classify).toHaveBeenCalledOnce();
  });

  it("returns HIGH + no deferredId when reviewer not wired", async () => {
    const fresh = new PermissionManager(tmpFile("permissions.json"));
    const r = await fresh.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/x" },
      allowedDirectories: [],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
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
      pathFields: ["path"],
      finalInput: { path: "/x" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });
    expect(r.verdict.level).toBe("high");
    expect(r.verdict.reason).toBe("async high");
    expect(asyncClassifier.classify).toHaveBeenCalled();
  });
});

// ─── MAJOR-1 R2: abortSignal end-to-end dispatchReviewer → LlmRiskClassifier ──

describe("MAJOR-1 R2: dispatchReviewer threads abortSignal to LlmRiskClassifier.classify", () => {
  it("calls LlmRiskClassifier.classify with the supplied abortSignal", async () => {
    const { pm } = makeManager();
    const ac = new AbortController();

    // Stub an LlmRiskClassifier-shaped classifier with a spy on classify.
    // We can't easily import LlmRiskClassifier here without a provider, so we
    // subclass to a minimal stand-in that records the opts argument.
    let capturedOpts: { abortSignal?: AbortSignal } | undefined;
    const { LlmRiskClassifier } = await import("../reviewer/risk-classifier.js");
    const { LlmReviewerProvider } = {} as never; // type only
    const providerStub = {
      complete: vi.fn(async () => ({
        text: '{"level":"low","reason":"ok"}',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      })),
    };
    const llmClassifier = new LlmRiskClassifier(providerStub, "gpt-4o-mini");
    const origClassify = llmClassifier.classify.bind(llmClassifier);
    vi.spyOn(llmClassifier, "classify").mockImplementation(
      async (ctx: import("../reviewer/risk-classifier.js").ToolInvocationContext, opts?: { abortSignal?: AbortSignal }) => {
        capturedOpts = opts;
        return origClassify(ctx, opts);
      },
    );

    const cache = new VerdictCache(tmpFile("reviewer-cache.jsonl"));
    const queue = new DeferredQueue(tmpFile("deferred-queue.jsonl"));
    pm.setReviewer({ classifier: llmClassifier, cache, deferredQueue: queue });

    await pm.dispatchReviewer(
      "bash",
      {
        source: "builtin",
        category: "shell",
        pathFields: [],
        finalInput: { command: "echo hello" },
        allowedDirectories: ["/Users/ken/work"],
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      },
      undefined,
      { abortSignal: ac.signal },
    );

    expect(capturedOpts?.abortSignal).toBe(ac.signal);
  });

  it("mid-call abort → classify throws and dispatchReviewer returns HIGH (fallbackOnError=deny)", async () => {
    const { pm } = makeManager();
    const ac = new AbortController();

    const { LlmRiskClassifier } = await import("../reviewer/risk-classifier.js");
    const providerStub = {
      complete: vi.fn(async (_params: { abortSignal?: AbortSignal }) => {
        // Abort during the in-flight call
        ac.abort();
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      }),
    };
    const llmClassifier = new LlmRiskClassifier(providerStub, "gpt-4o-mini", "deny");
    const cache = new VerdictCache(tmpFile("reviewer-cache.jsonl"));
    const queue = new DeferredQueue(tmpFile("deferred-queue.jsonl"));
    pm.setReviewer({ classifier: llmClassifier, cache, deferredQueue: queue });

    const result = await pm.dispatchReviewer(
      "bash",
      {
        source: "builtin",
        category: "shell",
        pathFields: [],
        finalInput: { command: "echo hello" },
        allowedDirectories: ["/Users/ken/work"],
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      },
      undefined,
      { abortSignal: ac.signal },
    );

    // fallbackOnError=deny → AbortError yields HIGH
    expect(result.verdict.level).toBe("high");
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
