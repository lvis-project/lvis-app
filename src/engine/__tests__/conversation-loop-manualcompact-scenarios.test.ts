/**
 * manualCompact — user-flow scenario suite for /compact slash command.
 *
 * Verifies behaviour from the user's perspective (not function-level):
 *   M3-A: at usagePct ≥ 80 with a no-op compact result → actionable
 *         deadlock guidance message (covers orange zone too, not just red).
 *   M3-B: at usagePct < 80 with a no-op compact result → generic
 *         "not needed" message.
 *   M3-C: successful compact returns compacted=true + removedMessageCount.
 *   Trigger: manualCompact emits onCompactStarted with triggerSource="manual".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { getModelPreflightThreshold } from "../auto-compact.js";

vi.mock("../structured-compact.js", () => ({
  compactWithBoundary: vi.fn(),
  renderBoundaryAsPreamble: vi.fn(() => "## Compact preamble"),
}));

import { compactWithBoundary } from "../structured-compact.js";

beforeEach(() => {
  vi.mocked(compactWithBoundary).mockClear();
});

function makeSettings() {
  return {
    get: (key: string) => {
      if (key === "chat") return { systemPrompt: "", autoCompact: true };
      if (key === "llm") return fakeLlmSettings({ provider: "claude", model: "claude-sonnet-4-5" });
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
    saveSession: vi.fn((id: string, msgs: GenericMessage[]) => {
      sessions[id] = msgs;
    }),
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

function makeProviderStub() {
  return {
    vendor: "claude" as const,
    streamTurn: async function* () {
      yield { type: "text_delta" as const, text: "ok" };
      yield { type: "message_complete" as const };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("manualCompact — /compact deadlock guidance (M3 scenarios)", () => {
  it("M3-A: at usagePct ≥ 80 with removedCount=0 returns actionable deadlock guidance", async () => {
    const threshold = getModelPreflightThreshold("claude", "claude-sonnet-4-5");
    // Build a history that estimates roughly 80%+ of preflight.
    const charsForOver80 = Math.ceil(threshold * 0.85 * 4);
    const big: GenericMessage[] = [
      { role: "user", content: "x".repeat(charsForOver80) },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(big) }));
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    // No-op compact result — message is too large to shrink under preserveRecent.
    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      boundary: {} as never,
      newHistory: big,
      removedCount: 0,
      estimatedAfter: 0,
    });

    const startedCb = vi.fn();
    const result = await loop.manualCompact({ onCompactStarted: startedCb });

    expect(result.compacted).toBe(false);
    expect(result.removedMessageCount).toBe(0);
    // The actionable branch must mention preflight % and tell user to start
    // a new session — the generic "불필요" branch must NOT be selected.
    expect(result.summary).toContain("줄일 수 있는 메시지가 없습니다");
    expect(result.summary).toContain("새 세션을 시작");
    expect(result.summary).not.toBe("컴팩트 불필요: 메시지 수가 충분히 적습니다.");
  });

  it("M3-B: at usagePct < 80 with removedCount=0 returns generic 'not needed' message", async () => {
    // Tiny history — well below 80% of preflight.
    const small: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(small) }));
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      boundary: {} as never,
      newHistory: small,
      removedCount: 0,
      estimatedAfter: 0,
    });

    const result = await loop.manualCompact();
    expect(result.compacted).toBe(false);
    expect(result.summary).toBe("컴팩트 불필요: 메시지 수가 충분히 적습니다.");
  });

  it("M3-C: successful compact returns compacted=true with removedMessageCount", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply2" },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(history) }));
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      boundary: {
        id: "b1",
        compactNum: 1,
        summary: { goal: "", constraints: "", progress: "", decisions: "", files: [], nextSteps: "", criticalContext: "", currentPlan: "", verificationState: "", openBlockers: "", unsafePendingActions: "", lastToolBoundary: "" },
        toolBoundaryLedger: [],
        pinnedArtifacts: [],
        createdAt: new Date().toISOString(),
      } as never,
      newHistory: history.slice(-2),
      removedCount: 2,
      estimatedAfter: 100,
    });

    const result = await loop.manualCompact();
    expect(result.compacted).toBe(true);
    expect(result.removedMessageCount).toBe(2);
  });

  it("Trigger: manualCompact fires onCompactStarted with triggerSource='manual'", async () => {
    const history: GenericMessage[] = [
      { role: "user", content: "x".repeat(40_000) },
    ];

    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(history) }));
    loop.resetAndResume("sess-1");
    (loop as unknown as { provider: ReturnType<typeof makeProviderStub> }).provider = makeProviderStub();

    vi.mocked(compactWithBoundary).mockResolvedValueOnce({
      boundary: {} as never,
      newHistory: history,
      removedCount: 0,
      estimatedAfter: 0,
    });

    const startedCb = vi.fn();
    await loop.manualCompact({ onCompactStarted: startedCb });

    expect(startedCb).toHaveBeenCalledTimes(1);
    const arg = startedCb.mock.calls[0]?.[0];
    expect(arg?.triggerSource).toBe("manual");
    expect(typeof arg?.estimatedBefore).toBe("number");
    expect(arg?.preflight).toBeGreaterThan(0);
  });
});
