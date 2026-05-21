/**
 * Token preflight guard — token accumulation → compact trigger → compactWithBoundary.
 *
 * Covers:
 * - estimate-based trigger: estimateMessagesTokens ≥ threshold → compact called
 * - actual-tokensIn-based trigger: last provider input ≥ threshold even when
 *   estimate is below (undercount scenario for code-heavy English content)
 * - message-count trigger: 50-message threshold starts compact instead of
 *   trimming the persisted session transcript
 * - autoCompact OFF → preflight skipped even when tokens exceed threshold
 * - disableSessionPersistence → preflight skipped
 * - threshold values: 80% of usable model context
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { getModelPreflightThreshold, estimateMessagesTokens } from "../auto-compact.js";

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

// ─── Stubs ────────────────────────────────────────────────────────────────────

function makeSettings(autoCompact = true, model = "claude-sonnet-4-5", provider: "claude" = "claude") {
  return {
    get: (key: string) => {
      if (key === "chat") return { systemPrompt: "", autoCompact };
      if (key === "llm") return fakeLlmSettings({ provider, model });
      return {};
    },
    getAll: () => ({}),
    patch: vi.fn(),
    getSecret: () => null,
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
  } as unknown as ConversationLoopDeps["settingsService"];
}

function makeMemoryManager(messages: GenericMessage[] = []) {
  const sessions: Record<string, GenericMessage[]> = { "sess-1": messages };
  return {
    listSessions: () => Object.keys(sessions).map((id) => ({ id, modifiedAt: new Date() })),
    loadSession: (id: string) => sessions[id] ?? null,
    loadSessionMetadata: vi.fn(() => null),
    saveSession: vi.fn((id: string, msgs: GenericMessage[]) => { sessions[id] = msgs; }),
    saveSessionMetadata: vi.fn(),
    appendCheckpoint: vi.fn((_meta: unknown, cp: unknown) => ({ checkpoints: [cp] })),
    saveCheckpointSnapshot: vi.fn(),
    listMemoryEntries: () => [],
    saveMemory: vi.fn(),
    deleteMemory: vi.fn(),
    searchMemoryEntries: vi.fn(),
    getMemoryContext: vi.fn(),
    getLvisMd: vi.fn(),
    updateLvisMd: vi.fn(),
    getUserPreferences: vi.fn(),
    updateUserPreferences: vi.fn(),
  } as unknown as ConversationLoopDeps["memoryManager"];
}

function makeDeps(overrides: Partial<ConversationLoopDeps> = {}): ConversationLoopDeps {
  return {
    settingsService: makeSettings(),
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: vi.fn(),
      setOriginSource: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveRolePrompt: vi.fn(),
    } as unknown as ConversationLoopDeps["systemPromptBuilder"],
    keywordEngine: {
      classify: vi.fn().mockReturnValue({ type: "chat" }),
      matchAllPluginIds: () => new Set(),
    } as unknown as ConversationLoopDeps["keywordEngine"],
    routeEngine: {
      route: vi.fn().mockReturnValue({ route: "llm" }),
    } as unknown as ConversationLoopDeps["routeEngine"],
    toolRegistry: {
      getToolSchemasForScope: () => [],
      getVisibleTools: () => [],
    } as unknown as ConversationLoopDeps["toolRegistry"],
    memoryManager: makeMemoryManager(),
    ...overrides,
  };
}

/**
 * Fake LLM provider for the actual turn (after compact). Just returns a short text.
 */
function makeTurnProvider() {
  return {
    vendor: "claude" as const,
    streamTurn: async function* () {
      yield { type: "text_delta" as const, text: "ok" };
      yield { type: "message_complete" as const };
    },
  };
}

/**
 * Build a synthetic CompactWithBoundaryResult that looks like a real compact.
 * The newHistory replaces all messages with a single boundary stub + one recent message.
 */
function makeSyntheticCompactResult(originalMessages: GenericMessage[]): import("../structured-compact.js").CompactWithBoundaryResult {
  const boundaryStub: GenericMessage = {
    role: "user",
    content: "[compact boundary stub]",
    meta: { isBoundaryStub: true } as unknown as GenericMessage["meta"],
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
});

describe("runPreflightGuard — actual-tokensIn secondary trigger", () => {
  it("calls compactWithBoundary when last provider input >= threshold even if estimate is below", async () => {
    // Scenario: estimator undercount — history text is code-heavy and the
    // actual provider-reported tokensIn exceeds threshold while
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

    // Simulate prior turn having reported an actual prompt size above threshold.
    (loop as unknown as { lastProviderInputTokens: number })
      .lastProviderInputTokens = threshold + 1_000;

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
    (loop as unknown as { lastProviderInputTokens: number })
      .lastProviderInputTokens = threshold - 1_000;

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
});

describe("runPreflightGuard — message-count trigger", () => {
  it("calls compactWithBoundary at 50 messages even when token estimates are below threshold", async () => {
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
    (loop as unknown as { lastProviderInputTokens: number })
      .lastProviderInputTokens = threshold - 1_000;

    vi.mocked(compactWithBoundary).mockResolvedValueOnce(makeSyntheticCompactResult(history));

    const compactStartedCb = vi.fn();
    await loop.runTurn(
      "message 50",
      { onCompactStarted: compactStartedCb },
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(compactWithBoundary).toHaveBeenCalled();
    expect(compactStartedCb).toHaveBeenCalledWith(
      expect.objectContaining({ triggerSource: "message-count" }),
    );
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
