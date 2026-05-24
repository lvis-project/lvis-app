/**
 * Token preflight guard — token accumulation → compact trigger → compactWithBoundary.
 *
 * Covers:
 * - estimate-based trigger: estimateMessagesTokens ≥ threshold → compact called
 * - context-token secondary trigger: last context-fill SOT ≥ threshold even when
 *   estimate is below (undercount scenario for code-heavy English content)
 * - message count is not a compact trigger; token preflight owns context pressure
 * - autoCompact OFF → preflight skipped even when tokens exceed threshold
 * - disableSessionPersistence → preflight skipped
 * - threshold values: 80% of usable model context
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import { getModelPreflightThreshold, estimateMessagesTokens } from "../auto-compact.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";
import {
  makeConversationLoopDeps as makeDeps,
  makeConversationLoopMemoryManager as makeMemoryManager,
  makeConversationLoopSettings as makeSettings,
  makeConversationTurnProvider as makeTurnProvider,
} from "./conversation-loop-test-helpers.js";

// ─── Module mock — intercept compactWithBoundary ──────────────────────────────
//
// vi.mock is hoisted to the top of the module at transform time, so it runs
// before any import. We mock structured-compact.js so compactWithBoundary
// returns a controlled result without requiring a real LLM call.

vi.mock("../structured-compact.js", () => ({
  DEFAULT_PRESERVE_RECENT_TURNS: 5,
  compactWithBoundary: vi.fn(),
  renderBoundaryAsPreamble: vi.fn(() => "## Compact preamble"),
}));

// Import the mock *after* vi.mock so we can configure return values per-test.
import { compactWithBoundary } from "../structured-compact.js";
import { CompressionStatus } from "../../shared/compact-status.js";

// Clear mock call history before each test so assertions are test-local.
beforeEach(() => {
  vi.mocked(compactWithBoundary).mockClear();
});

/**
 * Build a synthetic CompactWithBoundaryResult that looks like a real compact.
 * The newHistory replaces all messages with a single boundary stub + one recent message.
 */
function makeSyntheticCompactResult(originalMessages: GenericMessage[]): import("../structured-compact.js").CompactWithBoundaryResult {
  const boundaryStub: GenericMessage = {
    role: "user",
    content: "[compact boundary stub]",
    meta: {
      compactBoundary: true,
      compactNum: 1,
      checkpointMeta: {
        removedMessages: Math.max(0, originalMessages.length - 2),
        freedTokens: 1_000,
        compactNum: 1,
        trigger: "auto-compact",
      },
    },
  };
  const recent = originalMessages.slice(-2);
  return {
    status: CompressionStatus.SUMMARIZED,
    boundary: {
      id: "test-boundary-1",
      compactNum: 1,
      summary: { goal: "test", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
      toolBoundaryLedger: [],
      pinnedArtifacts: [],
      createdAt: new Date().toISOString(),
    } as unknown as NonNullable<import("../structured-compact.js").CompactWithBoundaryResult["boundary"]>,
    newHistory: [boundaryStub, ...recent],
    removedCount: originalMessages.length - recent.length - 1,
    estimatedAfter: 100,
    truncatedCount: 0,
  };
}

function makeSyntheticNoopResult(messages: GenericMessage[]): import("../structured-compact.js").CompactWithBoundaryResult {
  return {
    status: CompressionStatus.NOOP,
    boundary: null,
    newHistory: messages,
    removedCount: 0,
    estimatedAfter: 0,
    truncatedCount: 0,
  };
}

function makeSyntheticContentTruncatedResult(messages: GenericMessage[]): import("../structured-compact.js").CompactWithBoundaryResult {
  return {
    status: CompressionStatus.CONTENT_TRUNCATED,
    boundary: null,
    newHistory: messages.slice(-2),
    removedCount: 2,
    estimatedAfter: 100,
    truncatedDir: "/tmp/lvis-truncated",
    truncatedCount: 2,
  };
}

/**
 * Build a message array whose `estimateMessagesTokens` result EXCEEDS the
 * preflight threshold. Uses plain ASCII (no Korean weighting).
 */
function makeHistoryExceedingEstimateThreshold(threshold: number): GenericMessage[] {
  const charsPerMsg = (threshold / 2 + 500) * 4;
  return [
    { role: "user", content: "a".repeat(Math.ceil(charsPerMsg)) },
    { role: "assistant", content: "b".repeat(Math.ceil(charsPerMsg)) },
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runPreflightGuard — estimate-based trigger", () => {
  it("calls compactWithBoundary when estimateMessagesTokens ≥ threshold", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    expect(threshold).toBeGreaterThan(0);

    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const estimated = estimateMessagesTokens(history);
    expect(estimated).toBeGreaterThanOrEqual(threshold);

    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    // Configure mock to return a real-looking compact result.
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "hello",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // compactWithBoundary must have been called (estimate exceeded threshold).
    expect(compactWithBoundary).toHaveBeenCalled();
    // onCompactOccurred emitted from applyBoundaryToSession.
    expect(compactOccurredCb).toHaveBeenCalled();
  });

  it("persists post-compact context SOT on the boundary and clears preserved stale turn summaries", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const history: GenericMessage[] = [
      ...makeHistoryExceedingEstimateThreshold(threshold),
      { role: "user", content: "latest q" },
      {
        role: "assistant",
        content: "latest a",
        meta: {
          turnSummary: {
            turnDurationMs: 1_000,
            toolCount: 0,
            cumulativeToolMs: 0,
            tokensIn: threshold + 5_000,
            freshInputTokens: 100,
            tokensOut: 10,
          },
        },
      },
    ];
    const mem = makeMemoryManager(history);
    let summaryPreamble: string | null = null;
    const loop = new ConversationLoop(makeDeps({
      settingsService: settings,
      memoryManager: mem,
      systemPromptBuilder: {
        build: () => ["system", summaryPreamble].filter(Boolean).join("\n"),
        setSummaryPreamble: vi.fn((preamble: string | null) => {
          summaryPreamble = preamble;
        }),
        setToolScope: vi.fn(),
        setOriginSource: vi.fn(),
        setActiveSessionId: vi.fn(),
        setActiveRolePrompt: vi.fn(),
      } as never,
    }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    await loop.runTurn(
      "trigger compact",
      {},
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const messages = loop.getHistory().getMessages();
    const checkpointProjectionMessages = messages.slice(0, -1);
    const contextTokensAfter = messages[0]?.meta?.checkpointMeta?.contextTokensAfter;
    expect(contextTokensAfter).toBe(
      estimateRequestInputProjection({
        systemPrompt: "system\n## Compact preamble",
        messages: checkpointProjectionMessages,
        toolSchemas: [],
      }).totalTokens,
    );
    expect(contextTokensAfter).toBeGreaterThan(
      estimateRequestInputProjection({
        systemPrompt: "system",
        messages: checkpointProjectionMessages,
        toolSchemas: [],
      }).totalTokens,
    );
    const preservedOldAnswer = messages.find((message) => message.content === "latest a");
    expect(preservedOldAnswer?.meta?.turnSummary).toBeUndefined();
  });

  it("persists content-truncated compacts as checkpoint context carriers", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticContentTruncatedResult(history));

    await loop.runTurn(
      "trigger content truncation",
      {},
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const messages = loop.getHistory().getMessages();
    expect(messages[0]?.meta?.checkpointMeta).toMatchObject({
      compactStatus: CompressionStatus.CONTENT_TRUNCATED,
      contextTokensAfter: expect.any(Number),
      truncatedDir: "/tmp/lvis-truncated",
    });
    expect(messages[0]?.meta?.checkpointMeta?.contextTokensAfter).toBeGreaterThan(100);
    expect((mem as { saveCheckpointSnapshot: ReturnType<typeof vi.fn> }).saveCheckpointSnapshot)
      .toHaveBeenCalledWith("sess-1", 1, expect.any(Array));
  });
});

describe("runPreflightGuard — context-token secondary trigger", () => {
  it("calls compactWithBoundary when last context-fill SOT >= threshold even if estimate is below", async () => {
    // Scenario: estimator undercount — history text is code-heavy and the
    // context-fill SOT exceeds threshold while
    // estimateMessagesTokens is still below (chars/4 undercount).

    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    // Short history — estimate well below threshold.
    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    const estimated = estimateMessagesTokens(shortHistory);
    expect(estimated).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    // Simulate prior turn having reported a context-fill size above threshold.
    (loop as unknown as { lastContextInputTokens: number })
      .lastContextInputTokens = threshold + 1_000;

    // Configure mock: return a compact result (with removedCount > 0) so
    // applyBoundaryToSession fires and onCompactOccurred is emitted.
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(shortHistory));

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "next turn",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // Secondary trigger must have fired compactWithBoundary even though estimate was below.
    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactOccurredCb).toHaveBeenCalled();
  });

  it("does NOT compact only because cumulative input billing crossed threshold", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    expect(estimateMessagesTokens(shortHistory)).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    (loop as unknown as { cumulativeUsage: { inputTokens: number; outputTokens: number } })
      .cumulativeUsage = { inputTokens: threshold + 1_000, outputTokens: 500 };
    (loop as unknown as { lastContextInputTokens: number })
      .lastContextInputTokens = threshold - 1_000;

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "next turn",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactOccurredCb).not.toHaveBeenCalled();
  });

  it("adds the pending user input delta to the calibrated context-token preflight signal", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    const baselineEstimate = estimateMessagesTokens(shortHistory);
    const baselineProjection = estimateRequestInputProjection({
      systemPrompt: "system",
      messages: shortHistory,
      toolSchemas: [],
    }).totalTokens;
    expect(baselineEstimate).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    (loop as unknown as { lastContextInputTokens: number }).lastContextInputTokens = threshold - 100;
    (loop as unknown as { lastContextInputProjectionTokens: number }).lastContextInputProjectionTokens = baselineProjection;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(shortHistory));

    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "p".repeat(800),
      { onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStartedCb).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "context-tokens" }),
    );
  });
});

describe("runPreflightGuard — request projection source", () => {
  it("compacts when system prompt overhead crosses threshold even if message estimate is below", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const shortHistory: GenericMessage[] = [
      { role: "user", content: "short message" },
      { role: "assistant", content: "ok" },
    ];
    expect(estimateMessagesTokens(shortHistory)).toBeLessThan(threshold);

    const mem = makeMemoryManager(shortHistory);
    const loop = new ConversationLoop(makeDeps({
      settingsService: settings,
      memoryManager: mem,
      systemPromptBuilder: {
        build: () => "system-overhead ".repeat(threshold),
        setToolScope: vi.fn(),
        setOriginSource: vi.fn(),
        setActiveSessionId: vi.fn(),
        setActiveRolePrompt: vi.fn(),
      } as never,
    }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(shortHistory));

    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "next turn",
      { onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStartedCb).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "estimate" }),
    );
  });
});

describe("runPreflightGuard — message count is not a trigger", () => {
  it("does NOT compact at 50 messages when token signals are below threshold", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history: GenericMessage[] = Array.from({ length: 49 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `short ${i}`,
    }));
    expect(estimateMessagesTokens(history)).toBeLessThan(threshold);

    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    (loop as unknown as { lastContextInputTokens: number })
      .lastContextInputTokens = threshold - 1_000;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "message 50",
      { onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactStartedCb).not.toHaveBeenCalled();
  });
});

describe("runPreflightGuard — skip conditions", () => {
  it("does NOT call compactWithBoundary when autoCompact is OFF", async () => {
    const settings = makeSettings(false, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticNoopResult([]));

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "hello",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactOccurredCb).not.toHaveBeenCalled();
  });

  it("does NOT call compactWithBoundary when disableSessionPersistence is set", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");

    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(
      makeDeps({ settingsService: settings, memoryManager: mem, disableSessionPersistence: true }),
    );
    loop.resetAndResume("sess-1");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticNoopResult([]));

    const compactOccurredCb = vi.fn();
    await loop.runTurn(
      "hello",
      { onCompactOccurred: compactOccurredCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactOccurredCb).not.toHaveBeenCalled();
  });
});

describe("runPreflightGuard — force-recover hard-cap (#917)", () => {
  it("blocks compactWithBoundary after MAX_FORCE_RECOVER_PER_SESSION exhaustion and fires onRecoveryExhausted", async () => {
    // autoCompact ON so normal threshold gate would fire; force-recover budget exhausts first.
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-budget");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    // Simulate budget already exhausted: set count to MAX (3) directly.
    (loop as unknown as { contextErrorPending: boolean }).contextErrorPending = true;
    (loop as unknown as { contextErrorRecoveryCount: number }).contextErrorRecoveryCount = 3;

    // Mock compact to return success — should NOT be called.
    vi.mocked(compactWithBoundary).mockResolvedValue(makeSyntheticCompactResult(history));

    const recoveryExhaustedCb = vi.fn();
    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "trigger turn",
      { onRecoveryExhausted: recoveryExhaustedCb, onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    // Hard-cap: compactWithBoundary must NOT be called even though history exceeds threshold.
    expect(compactWithBoundary).not.toHaveBeenCalled();
    // Renderer must be notified of exhaustion.
    expect(recoveryExhaustedCb).toHaveBeenCalledTimes(1);
    // compact_started must NOT fire (no API call).
    expect(compactStartedCb).not.toHaveBeenCalled();
  });

  it("recoveryExhausted blocks subsequent turns until a clean turn re-arms it", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history = makeHistoryExceedingEstimateThreshold(threshold);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("sess-rearm");

    const fakeProvider = makeTurnProvider();
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    // Pre-set recoveryExhausted=true (as if prior turn triggered it).
    (loop as unknown as { recoveryExhausted: boolean }).recoveryExhausted = true;

    vi.mocked(compactWithBoundary).mockResolvedValue(makeSyntheticCompactResult(history));

    // First turn — recoveryExhausted blocks compact.
    const compactStartedCb1 = vi.fn();
    await loop.runTurn(
      "turn while exhausted",
      { onCompactStarted: compactStartedCb1 },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(compactStartedCb1).not.toHaveBeenCalled();

    // After a clean turn recoveryExhausted should be reset to false.
    expect((loop as unknown as { recoveryExhausted: boolean }).recoveryExhausted).toBe(false);
    expect((loop as unknown as { contextErrorRecoveryCount: number }).contextErrorRecoveryCount).toBe(0);

    // Next turn with context_error pending can force-recover again.
    vi.mocked(compactWithBoundary).mockClear();
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));
    (loop as unknown as { contextErrorPending: boolean }).contextErrorPending = true;

    const compactStartedCb2 = vi.fn();
    await loop.runTurn(
      "turn after re-arm",
      { onCompactStarted: compactStartedCb2 },
      undefined,
      { inputOrigin: "user-keyboard" },
    );
    // After re-arm force-recover can fire again.
    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStartedCb2).toHaveBeenCalled();
  });
});

describe("getPreflightThreshold — 80% usable-context trigger", () => {
  it("200K context threshold is 80% of 160K usable = 128K", () => {
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    expect(threshold).toBe(128_000);
  });

  it("128K context threshold is 80% of 98K usable = 78.4K", () => {
    const threshold = getModelPreflightThreshold("openai", "gpt-4o");
    expect(threshold).toBe(78_400);
  });
});
