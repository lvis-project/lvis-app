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
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { makeHistoryExceedingEstimateThreshold } from "./conversation-loop-test-helpers.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import type { TurnDecisionEvent } from "../turn/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { getModelPreflightThreshold, estimateMessagesTokens } from "../auto-compact.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";
import { t } from "../../i18n/index.js";
import {
  makeConversationLoopDeps as makeDeps,
  makeConversationLoopMemoryManager as makeMemoryManager,
  makeConversationLoopMemoryReviewer as makeMemoryReviewer,
  makeConversationLoopSettings as makeSettings,
  makeConversationTurnProvider as makeTurnProvider,
  makeSyntheticCompactResult,
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

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
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
    const memoryReviewer = makeMemoryReviewer();
    const loop = new ConversationLoop(
      makeDeps({ settingsService: settings, memoryManager: mem, memoryReviewer }),
    );
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    expect(compactWithBoundary).toHaveBeenCalledWith(expect.objectContaining({
      memoryReviewer,
      preflightTokens: threshold,
    }));
    const compactArgs = vi.mocked(compactWithBoundary).mock.calls[0]?.[0];
    expect(compactArgs).not.toHaveProperty("llm");
    expect(compactArgs).not.toHaveProperty("model");
    // onCompactOccurred emitted from applyBoundaryToSession.
    expect(compactOccurredCb).toHaveBeenCalled();
  });

  it("uses the provider-native projection for initial preflight", async () => {
    const settings = makeSettings(true, "claude-sonnet-4-5", "claude");
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    const history: GenericMessage[] = [{ role: "user", content: "short history" }];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("600d7495-e531-406e-8c73-da41ce614754");
    const projection = {
      totalTokens: threshold + 1,
      systemPromptTokens: 0,
      messageTokens: threshold + 1,
      toolSchemaTokens: 0,
    };
    const projectRequestInput = vi.fn(() => projection);
    const provider = { ...makeTurnProvider(), projectRequestInput };
    (loop as unknown as { provider: typeof provider }).provider = provider;
    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticNoopResult(history));
    const compactStarted = vi.fn();

    await loop.runTurn(
      "small current input",
      { onCompactStarted: compactStarted },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(projectRequestInput).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.any(String),
      messages: expect.any(Array),
      toolSchemas: expect.any(Array),
    }));
    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStarted).toHaveBeenCalledWith(expect.objectContaining({
      estimatedBefore: threshold + 1,
    }));
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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
      .toHaveBeenCalledWith("abe633f3-a47a-4758-874e-abe9160daf36", 1, expect.any(Array));
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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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

describe("queryLoop — rate-limit reactive compact", () => {
  it("runs auto-compact when provider reports rate_limit_exceeded for TPM", async () => {
    const settings = makeSettings(true, "gpt-5.4-mini", "openai");
    const history: GenericMessage[] = [
      { role: "user", content: "prior" },
      { role: "assistant", content: "ok" },
    ];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ settingsService: settings, memoryManager: mem }));
    loop.resetAndResume("3db55c54-315c-4806-83d0-954cb477fc3f");

    const message =
      "Rate limit reached for gpt-5.4-mini on tokens per min (TPM): Limit 200000, Used 161755, Requested 45096. Please try again in 2.055s.";
    const provider = new ScriptedProvider([
      [
        {
          type: "error",
          error: message,
          providerError: {
            origin: "provider",
            providerType: "tokens",
            providerCode: "rate_limit_exceeded",
            classification: "rate-limit",
            messagePreview: message,
            rateLimit: {
              kind: "tokens-per-minute",
              limit: 200_000,
              used: 161_755,
              requested: 45_096,
              retryAfterSeconds: 2.055,
            },
          },
        },
      ],
    ]);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    vi.mocked(compactWithBoundary).mockImplementationOnce(async ({ messages }) =>
      makeSyntheticCompactResult(messages as GenericMessage[]),
    );

    const compactStartedCb = vi.fn();
    const compactOccurredCb = vi.fn();
    const errorCb = vi.fn();
    const textDeltaCb = vi.fn();
    const result = await loop.runTurn(
      "trigger rate limit",
      {
        onCompactStarted: compactStartedCb,
        onCompactOccurred: compactOccurredCb,
        onError: errorCb,
        onTextDelta: textDeltaCb,
      },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalledTimes(1);
    // Recovery runs inside the turn, so the preserve floor has to count tool
    // rounds. Counting user turns pins the whole turn and compacts nothing.
    expect(compactWithBoundary).toHaveBeenCalledWith(
      expect.objectContaining({ preserveUnit: "tool-rounds" }),
    );
    expect(compactStartedCb).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "rate-limit" }),
    );
    expect(compactOccurredCb).toHaveBeenCalledTimes(1);
    expect(errorCb).not.toHaveBeenCalled();
    expect(textDeltaCb).toHaveBeenCalledWith(expect.stringContaining("자동 압축"));
    expect(result.text).toContain("압축된 컨텍스트");
  });

  it("does not compact for request-per-minute rate limits", async () => {
    const settings = makeSettings(true, "gpt-5.4-mini", "openai");
    const loop = new ConversationLoop(makeDeps({ settingsService: settings }));
    loop.resetAndResume("976a47ca-22a3-466f-89cf-d23575553788");

    const message = "Rate limit reached on requests per minute (RPM): Limit 100, Used 100, Requested 1.";
    const provider = new ScriptedProvider([
      [
        {
          type: "error",
          error: message,
          providerError: {
            origin: "provider",
            providerType: "requests",
            providerCode: "rate_limit_exceeded",
            classification: "rate-limit",
            messagePreview: message,
            rateLimit: { kind: "requests-per-minute", limit: 100, used: 100, requested: 1 },
          },
        },
      ],
    ]);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    vi.mocked(compactWithBoundary).mockResolvedValue(makeSyntheticCompactResult([]));

    const errorCb = vi.fn();
    await loop.runTurn(
      "trigger rpm",
      { onError: errorCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(errorCb).toHaveBeenCalled();
  });

  it("does not repeat TPM reactive compact before a clean turn re-arms recovery", async () => {
    const settings = makeSettings(true, "gpt-5.4-mini", "openai");
    const loop = new ConversationLoop(makeDeps({ settingsService: settings }));
    loop.resetAndResume("963e666f-23d2-4eae-86eb-c025879ef0c9");

    const message =
      "Rate limit reached for gpt-5.4-mini on tokens per min (TPM): Limit 200000, Used 161755, Requested 45096. Please try again in 2.055s.";
    const tpmError: StreamEvent = {
      type: "error",
      error: message,
      providerError: {
        origin: "provider",
        providerType: "tokens",
        providerCode: "rate_limit_exceeded",
        classification: "rate-limit",
        messagePreview: message,
        rateLimit: {
          kind: "tokens-per-minute",
          limit: 200_000,
          used: 161_755,
          requested: 45_096,
          retryAfterSeconds: 2.055,
        },
      },
    };
    const provider = new ScriptedProvider([[tpmError], [tpmError]]);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    vi.mocked(compactWithBoundary).mockImplementationOnce(async ({ messages }) =>
      makeSyntheticCompactResult(messages as GenericMessage[]),
    );

    const firstErrorCb = vi.fn();
    await loop.runTurn(
      "first tpm",
      { onError: firstErrorCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const secondErrorCb = vi.fn();
    await loop.runTurn(
      "second tpm",
      { onError: secondErrorCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalledTimes(1);
    expect(firstErrorCb).not.toHaveBeenCalled();
    expect(secondErrorCb).toHaveBeenCalled();
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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    loop.resetAndResume("abe633f3-a47a-4758-874e-abe9160daf36");

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
    loop.resetAndResume("ce88811d-036a-41cb-8b23-b1f47019842f");

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
    loop.resetAndResume("22c2d4bb-b1aa-4a8e-8cf6-2b448106ba8d");

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

/**
 * A turn that grows its own context past the threshold.
 *
 * The turn-start guard measures the history the user's message arrives with.
 * An agent turn then appends its own tool results for as many rounds as it
 * runs, and nothing re-measured that growth: the projection could cross the
 * threshold at round three and stay over for every round after it.
 */
class ToolLoopProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  roundsStarted = 0;

  constructor(private readonly toolRounds: number) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    const round = this.roundsStarted++;
    if (round < this.toolRounds) {
      yield { type: "tool_call", id: `tu-${round}`, name: "probe", input: { n: round } };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

/**
 * The one round that carries both a compaction and a pending re-prompt: two
 * tool rounds grow the history, a reasoning-only round arms the re-prompt, and
 * the round after it assembles the re-prompt AND crosses the threshold.
 */
class NudgeAndCompactProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly messages: GenericMessage[][] = [];
  private round = 0;

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.messages.push(input.messages);
    const round = this.round++;
    if (round < 2) {
      yield { type: "tool_call", id: `tu-${round}`, name: "probe", input: { n: round } };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    if (round <= 3) {
      yield { type: "reasoning_delta", text: REASONING_BLOCK };
      yield { type: "message_complete", stopReason: "end_turn" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

const REASONING_BLOCK = "weigh the next step. ".repeat(200);

function makeProbeRegistry(resultChars: number) {
  const registry = new ToolRegistry();
  registry.register(
    createDynamicTool({
      name: "probe",
      description: "returns a sizeable result",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: { n: { type: "number" } } },
      execute: async () => ({ output: "R".repeat(resultChars), isError: false }),
    }),
  );
  return registry;
}

function makeToolLoopSetup(resultChars: number, toolRounds: number) {
  const sessionId = "5c1f0f6d-0f0a-4a1e-9a3f-0b7cb6f2b1de";
  const provider = new ToolLoopProvider(toolRounds);
  const loop = new ConversationLoop(
    makeDeps({
      settingsService: makeSettings(true, "gpt-4o", "openai"),
      memoryManager: makeMemoryManager([], sessionId),
      memoryReviewer: makeMemoryReviewer(),
      toolRegistry: makeProbeRegistry(resultChars) as unknown as ReturnType<typeof makeDeps>["toolRegistry"],
    }),
  );
  loop.resetAndResume(sessionId);
  (loop as unknown as { provider: LLMProvider }).provider = provider;
  return { loop, provider };
}

describe("round-loop token preflight — a turn that grows its own context", () => {
  beforeEach(() => {
    // A small threshold stands in for a full context window: the gate reads the
    // same `getModelPreflightThreshold` the turn-start guard does.
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "5000";
    vi.mocked(compactWithBoundary).mockImplementation(
      async ({ messages }) => makeSyntheticCompactResult(messages),
    );
  });
  afterEach(() => {
    delete process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
    vi.mocked(compactWithBoundary).mockReset();
  });

  it("compacts mid-turn once the accumulated tool results cross the threshold", async () => {
    // ~1,500 tokens of tool result per round (kept under MAX_TOOL_RESULT_TOKENS
    // so the result reaches the wire whole) against a 5,000-token threshold:
    // the turn starts well under and crosses partway through.
    const { loop, provider } = makeToolLoopSetup(6_000, 8);
    const decisions: TurnDecisionEvent[] = [];
    const roundsWhenCompacted: number[] = [];
    vi.mocked(compactWithBoundary).mockImplementation(async ({ messages }) => {
      roundsWhenCompacted.push(provider.roundsStarted);
      return makeSyntheticCompactResult(messages);
    });

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    // Not at turn start: the turn began with an empty history and a short
    // question, so the only thing that could have crossed the threshold is the
    // turn's own tool output.
    expect(roundsWhenCompacted[0]).toBeGreaterThan(0);
    expect(decisions).toContainEqual(
      expect.objectContaining({ kind: "compact.auto", branch: "fired" }),
    );
    // Mid-turn the protected window has to be this turn's own tool rounds. On
    // the user-turn floor the whole turn sits inside the protected region and
    // the compactor reduces nothing, however far over the threshold it is.
    expect(compactWithBoundary).toHaveBeenCalledWith(
      expect.objectContaining({ preserveUnit: "tool-rounds" }),
    );
  });

  it("sends one instruction row, once, when the re-prompt round is also the compacting round", async () => {
    // Both the re-prompt and the compaction land in the same round, so the
    // round is assembled twice: once to measure it, once against the history
    // the compaction rewrote. An assembly that consumed the armed re-prompt
    // itself would spend the cap on the assembly that was only measured and
    // send the round that reaches the model without any instruction at all.
    const sessionId = "7c9d2b41-3e18-4c05-8b6a-9d4f1e0a2c73";
    // Measured on this shape: 1,169 projected tokens at the reasoning-only
    // round, 1,745 at the round after it, where the replayed reasoning and the
    // instruction join the history. A threshold between the two puts the
    // crossing exactly on the round that carries the re-prompt.
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "1400";
    const provider = new NudgeAndCompactProvider();
    const loop = new ConversationLoop(
      makeDeps({
        settingsService: makeSettings(true, "gpt-4o", "openai"),
        memoryManager: makeMemoryManager([], sessionId),
        memoryReviewer: makeMemoryReviewer(),
        toolRegistry: makeProbeRegistry(2_000) as unknown as ReturnType<typeof makeDeps>["toolRegistry"],
      }),
    );
    loop.resetAndResume(sessionId);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(decisions).toContainEqual(
      expect.objectContaining({ kind: "compact.auto", branch: "fired" }),
    );
    const instruction = t("be_conversationLoop.reasoningOnlyContinuePrompt");
    const rePromptRound = provider.messages[3] ?? [];
    // The round went out on the compacted history, not the one the gate
    // measured — and it still carries the instruction, exactly once.
    expect(rePromptRound[0]?.meta?.compactBoundary).toBe(true);
    expect(
      rePromptRound.filter(
        (message) =>
          typeof message.content === "string" && message.content.includes(instruction),
      ),
    ).toHaveLength(1);
    // And the cap was charged once for it: the second reasoning-only round
    // still sees one spend behind it, not two.
    expect(decisions.filter((event) => event.kind === "reasoning_only.continuation")).toEqual([
      expect.objectContaining({ branch: "continue", data: expect.objectContaining({ nudgesRun: 0 }) }),
      expect.objectContaining({ branch: "continue", data: expect.objectContaining({ nudgesRun: 1 }) }),
    ]);
  });

  it("leaves the turn-start guard on the between-turns preserve unit", async () => {
    const sessionId = "6ad1f0be-7b2c-4a9e-8f31-2c4d7e9a0b58";
    const history = makeHistoryExceedingEstimateThreshold(5_000);
    const loop = new ConversationLoop(
      makeDeps({
        settingsService: makeSettings(true, "gpt-4o", "openai"),
        memoryManager: makeMemoryManager(history, sessionId),
        memoryReviewer: makeMemoryReviewer(),
      }),
    );
    loop.resetAndResume(sessionId);
    (loop as unknown as { provider: LLMProvider }).provider = new ToolLoopProvider(0);

    await loop.runTurn("one more question", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(compactWithBoundary).toHaveBeenCalledWith(
      expect.not.objectContaining({ preserveUnit: expect.anything() }),
    );
  });

  it("leaves the turn-start guard as the only compaction when the history arrives over the threshold", async () => {
    // The round-loop gate skips the turn's first provider call precisely
    // because the turn-start guard already measured that request. A turn that
    // was already over must still compact exactly once, before round 0.
    const sessionId = "0f2b7a63-1a26-4f0e-9c1e-6a1a6a2b31c7";
    const history = makeHistoryExceedingEstimateThreshold(5_000);
    const provider = new ToolLoopProvider(0);
    const roundsWhenCompacted: number[] = [];
    vi.mocked(compactWithBoundary).mockImplementation(async ({ messages }) => {
      roundsWhenCompacted.push(provider.roundsStarted);
      return makeSyntheticCompactResult(messages);
    });
    const loop = new ConversationLoop(
      makeDeps({
        settingsService: makeSettings(true, "gpt-4o", "openai"),
        memoryManager: makeMemoryManager(history, sessionId),
        memoryReviewer: makeMemoryReviewer(),
      }),
    );
    loop.resetAndResume(sessionId);
    (loop as unknown as { provider: LLMProvider }).provider = provider;
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn(
      "one more question",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(roundsWhenCompacted).toEqual([0]);
    expect(decisions.filter((event) => event.kind === "compact.auto")).toEqual([]);
  });

  it("leaves a turn that stays under the threshold alone", async () => {
    const { loop } = makeToolLoopSetup(200, 6);
    const decisions: TurnDecisionEvent[] = [];

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).not.toHaveBeenCalled();
    expect(decisions.filter((event) => event.kind === "compact.auto")).toEqual([]);
  });

  it("does not fire again on the next round when a compaction left the projection over the threshold", async () => {
    // A compaction that reduced the history but not below the threshold used
    // to re-arm at zero, so the very next round crossed and compacted again.
    const { loop } = makeToolLoopSetup(1_200, 40);
    const decisions: TurnDecisionEvent[] = [];
    // Reduces by one message — real progress, still far over the threshold.
    vi.mocked(compactWithBoundary).mockImplementation(async ({ messages }) => ({
      status: CompressionStatus.SUMMARIZED,
      boundary: makeSyntheticCompactResult(messages).boundary,
      newHistory: messages.slice(1),
      removedCount: 1,
      estimatedAfter: 0,
      truncatedCount: 0,
    }));

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const held = decisions.filter(
      (event) => event.kind === "compact.auto" && event.branch === "rearm-hold",
    ).length;
    expect(vi.mocked(compactWithBoundary).mock.calls.length).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(0);
  });

  it("does not spend a compaction per round when compaction cannot reduce the history", async () => {
    // NOOP is the shape of "there was nothing left to summarize": the
    // projection stays over the threshold, so an ungated gate would spend an
    // LLM compaction on every remaining round of the turn.
    const { loop } = makeToolLoopSetup(1_200, 40);
    const decisions: TurnDecisionEvent[] = [];
    vi.mocked(compactWithBoundary).mockImplementation(
      async ({ messages }) => makeSyntheticNoopResult(messages),
    );

    await loop.runTurn(
      "run the probe until you are done",
      { onDecision: (event) => decisions.push(event) },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    const attempts = vi.mocked(compactWithBoundary).mock.calls.length;
    const held = decisions.filter(
      (event) => event.kind === "compact.auto" && event.branch === "rearm-hold",
    ).length;
    expect(attempts).toBeGreaterThan(0);
    // Rounds where the threshold was crossed and the gate declined anyway,
    // because nothing had grown enough for a boundary to cut differently.
    expect(held).toBeGreaterThan(0);
  });
});
