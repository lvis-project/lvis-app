/**
 * Permission policy P4 Area A — reviewer-wiring boot integration tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 5,
 * §11 v2.1 binding decisions.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wireReviewerAgent,
  LlmReviewerProviderAdapter,
} from "../reviewer-wiring.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import {
  RuleBasedRiskClassifier,
  DisabledRiskClassifier,
  LlmRiskClassifier,
} from "../../../permissions/reviewer/risk-classifier.js";
import type { LLMProvider, StreamEvent } from "../../../engine/llm/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "permission-policy-p4-rw-"));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** Factory for a stub LLMProvider that yields the supplied StreamEvents. */
function stubProvider(events: StreamEvent[]): LLMProvider {
  return {
    vendor: "openai",
    streamTurn: async function* () {
      for (const e of events) yield e;
    },
  };
}

describe("Permission policy P4 reviewer-wiring", () => {
  it("settings mode=rule wires RuleBasedRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const setReviewerSpy = vi.spyOn(pm, "setReviewer");
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "rule",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(RuleBasedRiskClassifier);
    expect(setReviewerSpy).toHaveBeenCalledOnce();
    expect(pm.hasReviewer()).toBe(true);
  });

  it("settings mode=disabled wires DisabledRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "disabled",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "rule",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(DisabledRiskClassifier);
    expect(pm.hasReviewer()).toBe(true);
  });

  it("settings mode=llm + provider available wires LlmRiskClassifier", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const provider = stubProvider([
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const factorySpy = vi.fn((vendor: string) =>
      vendor === "openai" ? provider : null,
    );
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "llm",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "rule",
        interactive: { autoApprove: "off" },
      }),
      streamProviderFor: factorySpy,
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.classifier).toBeInstanceOf(LlmRiskClassifier);
    expect(factorySpy).toHaveBeenCalledWith("openai");
    expect(pm.hasReviewer()).toBe(true);
  });

  it("mode=llm but no streamProviderFor → throws (atomic cutover)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    expect(() =>
      wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "llm",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "rule",
          interactive: { autoApprove: "off" },
        }),
        verdictCachePath: join(tmpDir, "cache.jsonl"),
        deferredQueuePath: join(tmpDir, "queue.jsonl"),
      }),
    ).toThrow(/streamProviderFor/);
    expect(pm.hasReviewer()).toBe(false);
  });

  it("mode=llm but factory returns null → throws (no silent fallback)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    expect(() =>
      wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "llm",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          fallbackOnError: "rule",
          interactive: { autoApprove: "off" },
        }),
        streamProviderFor: () => null,
        verdictCachePath: join(tmpDir, "cache.jsonl"),
        deferredQueuePath: join(tmpDir, "queue.jsonl"),
      }),
    ).toThrow(/anthropic.*not configured/);
  });

  it("preserves caller-supplied settings on appliedSettings", () => {
    // Settings loaded externally and passed in via readSettings; assert
    // the wiring surfaces the same block on its result.
    const settingsPath = join(tmpDir, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: {
          additionalDirectories: [],
          reviewer: {
            mode: "rule",
            provider: "google",
            model: "gemini-2.0-flash",
            fallbackOnError: "deny",
            interactive: { autoApprove: "off" },
          },
        },
      }),
    );
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    const result = wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "google",
        model: "gemini-2.0-flash",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.appliedSettings.provider).toBe("google");
    expect(result.appliedSettings.fallbackOnError).toBe("deny");
  });

  it("pushes interactive.autoApprove onto the live PermissionManager instance (round-3 test-engineer MAJOR-1)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "low" },
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    // Critical post-rewire invariant — the live PermissionManager state
    // reflects the persisted settings without requiring a process
    // restart. A refactor that drops setInteractiveAutoApprove() must
    // be caught here.
    expect(pm.getInteractiveAutoApprove()).toBe("low");
  });

  it("logs boot warning when mode=auto + interactive.autoApprove=off (round-5 test-engineer MAJOR)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    pm.setMode("auto");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "rule",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "off" },
        }),
        verdictCachePath: join(tmpDir, "cache-warn-auto-off.jsonl"),
        deferredQueuePath: join(tmpDir, "queue-warn-auto-off.jsonl"),
      });
      // The logger calls into pino which may stream via console or a
      // dedicated transport. We use a permissive assertion that fires
      // when *any* warn-level emission contains the canonical phrase.
      // Round-6 test-engineer CRITICAL — strict assertion. The earlier
      // `fired || calls.length===0` form was a tautology that passed
      // even when the warn never fired. The logger's vitest path
      // routes through `console.warn` directly (lib/logger.ts), so
      // `warnSpy.mock.calls` is the SOT.
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("legacy exec mode=auto")),
      );
      expect(fired).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs boot warning when mode=strict + interactive.autoApprove=low (round-5 test-engineer MAJOR)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    pm.setMode("strict");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      wireReviewerAgent({
        permissionManager: pm,
        readSettings: () => ({
          mode: "rule",
          provider: "openai",
          model: "gpt-4o-mini",
          fallbackOnError: "deny",
          interactive: { autoApprove: "low" },
        }),
        verdictCachePath: join(tmpDir, "cache-warn-strict.jsonl"),
        deferredQueuePath: join(tmpDir, "queue-warn-strict.jsonl"),
      });
      const fired = warnSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("exec mode=strict")),
      );
      // Round-6 test-engineer CRITICAL — strict, no-tautology assertion.
      expect(fired).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("re-rewiring with a different interactive.autoApprove updates the live state (round-3 test-engineer MAJOR-1)", () => {
    const pm = new PermissionManager(join(tmpDir, "permissions.json"));
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "low" },
      }),
      verdictCachePath: join(tmpDir, "cache-1.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-1.jsonl"),
    });
    expect(pm.getInteractiveAutoApprove()).toBe("low");
    wireReviewerAgent({
      permissionManager: pm,
      readSettings: () => ({
        mode: "rule",
        provider: "openai",
        model: "gpt-4o-mini",
        fallbackOnError: "deny",
        interactive: { autoApprove: "off" },
      }),
      verdictCachePath: join(tmpDir, "cache-2.jsonl"),
      deferredQueuePath: join(tmpDir, "queue-2.jsonl"),
    });
    expect(pm.getInteractiveAutoApprove()).toBe("off");
  });
});

describe("Permission policy P4 LlmReviewerProviderAdapter", () => {
  it("collects streamTurn `text_delta` events into a single string", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: '{"level":' },
      { type: "text_delta", text: ' "low",' },
      { type: "text_delta", text: ' "reason": "ok"}' },
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 6 },
      },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const out = await adapter.complete({
      model: "gpt-4o-mini",
      systemPrompt: "system",
      userPrompt: "user",
    });
    expect(out.text).toBe('{"level": "low", "reason": "ok"}');
    expect(out.tokensIn).toBe(10);
    expect(out.tokensOut).toBe(6);
  });

  it("ignores reasoning_delta + tool_call events", async () => {
    const provider = stubProvider([
      { type: "reasoning_delta", text: "thinking..." },
      { type: "text_delta", text: '{"level":"high"}' },
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const out = await adapter.complete({
      model: "claude-haiku",
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(out.text).toBe('{"level":"high"}');
  });

  it("throws on `error` stream event", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: '{"level":"low"}' },
      { type: "error", error: "rate limit" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    await expect(
      adapter.complete({
        model: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
      }),
    ).rejects.toThrow(/rate limit/);
  });

  it("aborts mid-stream when abortSignal fires", async () => {
    const provider = stubProvider([
      { type: "text_delta", text: "first" },
      { type: "text_delta", text: "second" },
    ]);
    const adapter = new LlmReviewerProviderAdapter(provider);
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.complete({
        model: "gpt-4o-mini",
        systemPrompt: "s",
        userPrompt: "u",
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
