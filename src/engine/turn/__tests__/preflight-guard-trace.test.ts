/**
 * O-1: compaction-path observability.
 *
 * `runPreflightGuard` decides fired / skipped / not-reached on every turn but
 * previously emitted nothing to `~/.lvis/traces` — the only way to answer "is
 * compaction running?" was to reverse-engineer it from raw token telemetry.
 * These tests assert the `PREFLIGHT_GUARD` (+ `COMPACTION_RESULT` on the fired
 * path) trace steps carry the decision, without asserting on log lines or
 * prompt/message content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeHistoryExceedingEstimateThreshold } from "../../__tests__/conversation-loop-test-helpers.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { ConversationLoopDeps } from "../../conversation-loop.js";
import type { GenericMessage } from "../../llm/types.js";
import { getModelPreflightThreshold, estimateMessagesTokens } from "../../auto-compact.js";
import { getPreflightThreshold } from "../../../shared/context-budget.js";
import { llmModelListCacheKey } from "../../../shared/llm-model-list.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import type { ConversationTracer, TraceStepName } from "../../../observability/conversation-trace.js";
import {
  makeConversationLoopDeps as makeDeps,
  makeConversationLoopMemoryManager as makeMemoryManager,
  makeConversationLoopMemoryReviewer as makeMemoryReviewer,
  makeConversationLoopSettings as makeSettings,
  makeConversationTurnProvider as makeTurnProvider,
  makeSyntheticCompactResult,
} from "../../__tests__/conversation-loop-test-helpers.js";

// vi.mock is hoisted — intercept compactWithBoundary so the fired path
// resolves without a real LLM call (same pattern as conversation-loop-preflight.test.ts).
vi.mock("../../structured-compact.js", () => ({
  DEFAULT_PRESERVE_RECENT_TURNS: 5,
  compactWithBoundary: vi.fn(),
  renderBoundaryAsPreamble: vi.fn(() => "## Compact preamble"),
}));

import { compactWithBoundary } from "../../structured-compact.js";
import { CompressionStatus } from "../../../shared/compact-status.js";

beforeEach(() => {
  vi.mocked(compactWithBoundary).mockClear();
});

class RecordingTracer implements ConversationTracer {
  readonly enabled = true;
  readonly filePath = undefined;
  steps: Array<{ name: TraceStepName; meta?: Record<string, unknown> }> = [];
  step(name: TraceStepName, meta?: Record<string, unknown>): void {
    this.steps.push({ name, meta });
  }
}


describe("PREFLIGHT_GUARD trace step — fired path", () => {
  it("emits PREFLIGHT_GUARD(fired) then COMPACTION_RESULT(applied) with threshold + source, no message content", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);
    expect(estimateMessagesTokens(history)).toBeGreaterThanOrEqual(threshold);

    const mem = makeMemoryManager(history, "691e64c5-38fd-48cc-89cd-d247f6245aca");
    const memoryReviewer = makeMemoryReviewer();
    const loop = new ConversationLoop(
      makeDeps({ settingsService: settings, memoryManager: mem, memoryReviewer }),
    );
    loop.resetAndResume("691e64c5-38fd-48cc-89cd-d247f6245aca");
    const rec = new RecordingTracer();
    loop.setTracer(rec);

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard" });

    const guardStep = rec.steps.find((s) => s.name === "PREFLIGHT_GUARD");
    expect(guardStep?.meta).toMatchObject({
      outcome: "fired",
      threshold,
      thresholdSource: "context-window",
      contextWindowSource: "pricing-catalog",
      model: "claude/claude-sonnet-4-5",
      estimated: expect.any(Number),
      contextTokensIn: expect.any(Number),
    });

    const resultStep = rec.steps.find((s) => s.name === "COMPACTION_RESULT");
    expect(resultStep?.meta).toMatchObject({
      status: "applied",
      removedCount: expect.any(Number),
      estimatedAfter: expect.any(Number),
      compactNum: expect.any(Number),
    });

    // Diagnostic only — never the conversation content.
    expect(JSON.stringify(rec.steps)).not.toContain("a".repeat(50));
  });

  /**
   * A settings double whose `llm` block is the one the route actually reads:
   * the vendor block carries the declared window, and `modelListCache` carries
   * the row a `/models` handshake left behind.
   */
  function makeWindowSettings(overrides: {
    contextWindow?: number;
    reportedContextLength?: number;
  }) {
    const model = "a-model-no-catalog-knows";
    const llm = fakeLlmSettings({ provider: "openai-compatible", model }) as Record<string, unknown>;
    const vendors = llm.vendors as Record<string, Record<string, unknown>>;
    vendors["openai-compatible"].baseUrl = "https://models.invalid/v1";
    if (overrides.contextWindow !== undefined) {
      vendors["openai-compatible"].contextWindow = overrides.contextWindow;
    }
    if (overrides.reportedContextLength !== undefined) {
      llm.modelListCache = {
        [llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "")]: {
          vendor: "openai-compatible",
          baseUrl: "https://models.invalid/v1",
          endpoint: "https://models.invalid/v1/models",
          models: [model],
          modelEntries: [{ id: model, contextLength: overrides.reportedContextLength }],
          fetchedAt: new Date().toISOString(),
        },
      };
    }
    return {
      get: (key: string) => {
        if (key === "chat") return { systemPrompt: "", autoCompact: true };
        if (key === "llm") return llm;
        return {};
      },
      getAll: () => ({}),
      patch: vi.fn(),
      getSecret: () => null,
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    } as unknown as ConversationLoopDeps["settingsService"];
  }

  async function tracedGuardMeta(
    settingsService: ConversationLoopDeps["settingsService"],
    sessionId: string,
    history: GenericMessage[],
  ): Promise<Record<string, unknown> | undefined> {
    const loop = new ConversationLoop(
      makeDeps({
        settingsService,
        memoryManager: makeMemoryManager(history, sessionId),
        memoryReviewer: makeMemoryReviewer(),
      }),
    );
    loop.resetAndResume(sessionId);
    const rec = new RecordingTracer();
    loop.setTracer(rec);
    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard" });

    return rec.steps.find((s) => s.name === "PREFLIGHT_GUARD")?.meta;
  }

  it("budgets against the window declared on the vendor block", async () => {
    const meta = await tracedGuardMeta(
      makeWindowSettings({ contextWindow: 400_000, reportedContextLength: 229_376 }),
      "9c7a1f2e-6b3d-4a0c-8e11-2f7a9b4c5d63",
      makeHistoryExceedingEstimateThreshold(getPreflightThreshold(400_000)),
    );

    expect(meta).toMatchObject({
      contextWindowSource: "vendor-setting",
      threshold: getPreflightThreshold(400_000),
    });
  });

  it("budgets against what the provider reported when nothing was declared", async () => {
    const meta = await tracedGuardMeta(
      makeWindowSettings({ reportedContextLength: 229_376 }),
      "3d5c8b1a-7e42-4f19-b0a6-8c2e4d9f1b07",
      makeHistoryExceedingEstimateThreshold(getPreflightThreshold(229_376)),
    );

    expect(meta).toMatchObject({
      contextWindowSource: "provider-reported",
      threshold: getPreflightThreshold(229_376),
    });
  });

  it("names the fallback window as a fallback when no source knows the model", async () => {
    // The budget for a model nothing knows rests on the conservative 128K
    // guess. A reader of the trace has to be able to tell that apart from a
    // budget the catalog or the provider actually answered for, or a served
    // model with a 229K window looks like it was compacted on purpose.
    const settings = makeSettings(true, "a-model-no-catalog-knows", "openai-compatible");
    const threshold = getModelPreflightThreshold("openai-compatible", "a-model-no-catalog-knows");
    const history = makeHistoryExceedingEstimateThreshold(threshold);

    const mem = makeMemoryManager(history, "4b0e2f6a-9d2e-4a55-9d6b-4d5a6c8f2a11");
    const loop = new ConversationLoop(
      makeDeps({
        settingsService: settings,
        memoryManager: mem,
        memoryReviewer: makeMemoryReviewer(),
      }),
    );
    loop.resetAndResume("4b0e2f6a-9d2e-4a55-9d6b-4d5a6c8f2a11");
    const rec = new RecordingTracer();
    loop.setTracer(rec);
    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(rec.steps.find((s) => s.name === "PREFLIGHT_GUARD")?.meta).toMatchObject({
      contextWindowSource: "fallback",
      model: "openai-compatible/a-model-no-catalog-knows",
    });
  });

  it("emits COMPACTION_RESULT(noop) when compactWithBoundary returns NOOP", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);

    const mem = makeMemoryManager(history, "8a2099ef-3b22-46a7-84ec-1c42b6fc0f00");
    const memoryReviewer = makeMemoryReviewer();
    const loop = new ConversationLoop(
      makeDeps({ settingsService: settings, memoryManager: mem, memoryReviewer }),
    );
    loop.resetAndResume("8a2099ef-3b22-46a7-84ec-1c42b6fc0f00");
    const rec = new RecordingTracer();
    loop.setTracer(rec);

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      status: CompressionStatus.NOOP,
      boundary: null,
      newHistory: history,
      removedCount: 0,
      estimatedAfter: 0,
      truncatedCount: 0,
    });

    await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard" });

    const guardStep = rec.steps.find((s) => s.name === "PREFLIGHT_GUARD");
    expect(guardStep?.meta).toMatchObject({ outcome: "fired" });
    const resultStep = rec.steps.find((s) => s.name === "COMPACTION_RESULT");
    expect(resultStep?.meta).toMatchObject({ status: "noop" });
  });
});

describe("PREFLIGHT_GUARD trace step — skipped / not-reached paths", () => {
  it("emits PREFLIGHT_GUARD(not-reached) below threshold and no COMPACTION_RESULT", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history: GenericMessage[] = [{ role: "user", content: "short history" }];
    expect(estimateMessagesTokens(history)).toBeLessThan(threshold);

    const mem = makeMemoryManager(history, "050713c0-1d80-4e8f-8897-3c571585ddc5");
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("050713c0-1d80-4e8f-8897-3c571585ddc5");
    const rec = new RecordingTracer();
    loop.setTracer(rec);

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(compactWithBoundary).not.toHaveBeenCalled();
    const guardStep = rec.steps.find((s) => s.name === "PREFLIGHT_GUARD");
    expect(guardStep?.meta).toMatchObject({
      outcome: "not-reached",
      reason: "below-threshold",
      threshold,
      thresholdSource: "context-window",
      model: "claude/claude-sonnet-4-5",
    });
    expect(rec.steps.find((s) => s.name === "COMPACTION_RESULT")).toBeUndefined();
  });

  it("emits PREFLIGHT_GUARD(skipped, auto-compact-disabled) when autoCompact setting is OFF", async () => {
    const settings = makeSettings(false, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);

    const mem = makeMemoryManager(history, "7e4a73fc-74db-42d9-824a-1d79359e927f");
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("7e4a73fc-74db-42d9-824a-1d79359e927f");
    const rec = new RecordingTracer();
    loop.setTracer(rec);

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(compactWithBoundary).not.toHaveBeenCalled();
    const guardStep = rec.steps.find((s) => s.name === "PREFLIGHT_GUARD");
    expect(guardStep?.meta).toMatchObject({
      outcome: "skipped",
      reason: "auto-compact-disabled",
    });
  });
});
