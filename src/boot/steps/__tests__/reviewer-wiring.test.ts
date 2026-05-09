/**
 * Q12 P4 Area A — reviewer-wiring boot integration tests.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 5,
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
  tmpDir = mkdtempSync(join(tmpdir(), "q12-p4-rw-"));
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

describe("Q12 P4 reviewer-wiring", () => {
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
      }),
      verdictCachePath: join(tmpDir, "cache.jsonl"),
      deferredQueuePath: join(tmpDir, "queue.jsonl"),
    });
    expect(result.appliedSettings.provider).toBe("google");
    expect(result.appliedSettings.fallbackOnError).toBe("deny");
  });
});

describe("Q12 P4 LlmReviewerProviderAdapter", () => {
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
