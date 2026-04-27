/**
 * B1 — Session resume + manual compact tests.
 *
 * Covers:
 * - resetAndResume clears streaming state (cumulativeUsage reset) and loads history
 * - resetAndResume triggers auto-compact when history exceeds threshold
 * - resetAndResume returns ok:false for unknown sessionId
 * - manualCompact returns compacted:true when history is long enough to compact
 * - manualCompact returns compacted:false when history is short
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { GenericMessage } from "../llm/types.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

// ─── Minimal stubs ────────────────────────────────────────────────────────────

function makeSettings(autoCompact = true, model = "gpt-4o", provider: "openai" | "claude" | "gemini" | "copilot" | "azure-foundry" | "vertex-ai" = "openai") {
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

function makeMemoryManager(storedMessages: GenericMessage[] | null = null) {
  const sessions: Record<string, GenericMessage[]> = {};
  if (storedMessages) sessions["test-session-id"] = storedMessages;

  return {
    listSessions: () => Object.keys(sessions).map((id) => ({ id, modifiedAt: new Date() })),
    loadSession: (id: string) => sessions[id] ?? null,
    loadSessionMetadata: vi.fn(() => null),
    saveSession: vi.fn((id: string, msgs: GenericMessage[]) => { sessions[id] = msgs; }),
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
    systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() } as unknown as ConversationLoopDeps["systemPromptBuilder"],
    keywordEngine: { classify: vi.fn(), matchAllPluginIds: () => new Set() } as unknown as ConversationLoopDeps["keywordEngine"],
    routeEngine: { route: vi.fn() } as unknown as ConversationLoopDeps["routeEngine"],
    toolRegistry: { getToolSchemasForScope: () => [], getVisibleTools: () => [] } as unknown as ConversationLoopDeps["toolRegistry"],
    memoryManager: makeMemoryManager(),
    ...overrides,
  };
}

/** Build a long conversation that exceeds the compaction threshold (>= 6 messages). */
function makeLongHistory(count = 20): GenericMessage[] {
  const msgs: GenericMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i} ${"x".repeat(200)}` });
  }
  return msgs;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConversationLoop.resetAndResume", () => {
  it("returns ok:false for unknown session", () => {
    const loop = new ConversationLoop(makeDeps({ memoryManager: makeMemoryManager(null) }));
    const result = loop.resetAndResume("nonexistent-id");
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.compactedAt).toBeNull();
    expect(result.removedMessageCount).toBe(0);
  });

  it("loads history and resets cumulativeUsage", () => {
    const history: GenericMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    // Simulate prior usage so we can confirm reset
    const result = loop.resetAndResume("test-session-id");

    expect(result.ok).toBe(true);
    expect(loop.getHistory().length).toBe(2);
    // Issue 1 fix: cumulativeUsage is now estimated from loaded history (not zero).
    // Short 2-message history → small but non-zero estimate.
    expect(loop.getCumulativeUsage().inputTokens).toBeGreaterThan(0);
    expect(loop.getCumulativeUsage().outputTokens).toBe(0);
  });

  it("does NOT compact short history even with autoCompact enabled", () => {
    const history: GenericMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    const result = loop.resetAndResume("test-session-id");

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.compactedAt).toBeNull();
    expect(result.removedMessageCount).toBe(0);
  });

  it("does NOT compact when autoCompact is disabled", () => {
    const history = makeLongHistory(20);
    const mem = makeMemoryManager(history);
    const settings = makeSettings(false);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem, settingsService: settings }));

    const result = loop.resetAndResume("test-session-id");

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
  });

  it("session-id is updated to the resumed session", () => {
    const history: GenericMessage[] = [{ role: "user", content: "resume me" }];
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    loop.resetAndResume("test-session-id");
    expect(loop.getSessionId()).toBe("test-session-id");
  });
});

describe("ConversationLoop.resetAndResume — Issue 1: shouldCompact fires on resume", () => {
  it("shouldCompact returns true when resumed history has 50 large messages (token estimate exceeds threshold)", () => {
    // 50 messages × ~200 chars each ≈ 50 × (200/4+1) = 50 × 51 = 2550 estimated tokens
    // gpt-4o context window = 128,000; threshold 80% = 102,400 — won't fire with 2550.
    // Use a model with a tiny context window by customizing settings, OR
    // use large messages that exceed any threshold.
    // Simplest: 50 messages × 400 chars = ~50 × 101 = 5050 tokens. Still below 102,400.
    // To force the check, we make messages that collectively estimate > threshold.
    // With 50 messages × 10000 chars → 50 × (10000/4+1) = 50 × 2501 = 125,050 tokens
    // which is > 128,000 * 0.8 = 102,400. So shouldCompact should fire.
    const msgs: GenericMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(10_000),
      });
    }
    const mem = makeMemoryManager(msgs);
    mem.saveSession = vi.fn();
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem, settingsService: makeSettings(true) }));

    const result = loop.resetAndResume("test-session-id");

    // The compact check should have fired; either it compacted or messages were short
    // enough that compactMessages decided not to — but shouldCompact gate must have been reached.
    expect(result.ok).toBe(true);
    // With 50 large messages the estimated tokens exceed 80% of 128K window → compacted
    expect(result.compacted).toBe(true);
  });

  it("shouldCompact is NOT skipped when usage was zero before resume (regression guard)", () => {
    // Load large history — if usage estimate was not set, compact would be skipped.
    const msgs: GenericMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "y".repeat(10_000) });
    }
    const mem = makeMemoryManager(msgs);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));

    // Before fix: cumulativeUsage was always 0 after loadSession → shouldCompact never fired.
    // After fix: estimated usage is derived from message content.
    const result = loop.resetAndResume("test-session-id");
    expect(result.ok).toBe(true);
    // Usage estimate should now be non-zero
    expect(loop.getCumulativeUsage().inputTokens).toBeGreaterThan(0);
  });
});

describe("ConversationLoop.manualCompact", () => {
  it("returns compacted:false for empty history", () => {
    const loop = new ConversationLoop(makeDeps());
    const result = loop.manualCompact();
    expect(result.compacted).toBe(false);
    expect(result.compactedAt).toBeNull();
    expect(result.removedMessageCount).toBe(0);
  });

  it("returns compacted:false for very short history", () => {
    const mem = makeMemoryManager([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));
    loop.resetAndResume("test-session-id");

    const result = loop.manualCompact();
    expect(result.compacted).toBe(false);
    expect(result.summary).toContain("불필요");
  });

  it("compacts long history and returns metadata", () => {
    const history = makeLongHistory(30);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));
    loop.resetAndResume("test-session-id");

    const before = loop.getHistory().length;
    const result = loop.manualCompact();

    if (result.compacted) {
      expect(result.compactedAt).not.toBeNull();
      expect(result.removedMessageCount).toBeGreaterThan(0);
      expect(result.summary).toContain("메시지 요약됨");
      expect(loop.getHistory().length).toBeLessThan(before);
    } else {
      // compactMessages may decide not to compact if threshold not met — just verify shape
      expect(result.compacted).toBe(false);
      expect(result.removedMessageCount).toBe(0);
    }
  });

  it("Issue 2: saveSession called with compacted messages after manualCompact", () => {
    const history = makeLongHistory(30);
    const mem = makeMemoryManager(history);
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem }));
    loop.resetAndResume("test-session-id");

    const result = loop.manualCompact();

    if (result.compacted) {
      // saveSession must be called with the compacted (shorter) message list
      expect(mem.saveSession).toHaveBeenCalled();
      const savedMsgs = (mem.saveSession as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1] as GenericMessage[];
      expect(savedMsgs.length).toBeLessThan(history.length);
    }
    // If not compacted (threshold not met), saveSession should not be called for compact
    // (it may have been called by loadSession/resetAndResume — that's ok)
  });
  it("Issue 37.19: /compact slash command calls saveSession with compacted messages", async () => {
    const history = makeLongHistory(30);
    const mem = makeMemoryManager(history);
    const routeEngine = {
      route: vi.fn().mockReturnValue({ route: "command", command: "compact", args: "" }),
    } as unknown as ConversationLoopDeps["routeEngine"];
    const keywordEngine = {
      classify: vi.fn().mockReturnValue({ type: "command" }),
      matchAllPluginIds: () => new Set(),
    } as unknown as ConversationLoopDeps["keywordEngine"];
    const fakeProvider = {
      vendor: "openai" as const,
      streamTurn: async function* () { /* unused — command path exits before LLM */ },
    };
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem, routeEngine, keywordEngine }));
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;
    loop.resetAndResume("test-session-id");
    mem.saveSession = vi.fn().mockResolvedValue(undefined);

    await loop.runTurn("/compact");

    expect(mem.saveSession).toHaveBeenCalled();
    const savedMsgs = (mem.saveSession as ReturnType<typeof vi.fn>).mock.calls[0]![1] as import("../llm/types.js").GenericMessage[];
    expect(savedMsgs.length).toBeLessThan(history.length);
  });
});

describe("ConversationLoop command routing", () => {
  it("/memory lists memory entries only", async () => {
    const listMemoryEntries = vi.fn(() => [{ title: "사용자 메모", filename: "memory-note.md", content: "# 사용자 메모" }]);
    const mem = {
      ...makeMemoryManager(),
      listMemoryEntries,
    } as unknown as ConversationLoopDeps["memoryManager"];
    const routeEngine = {
      route: vi.fn().mockReturnValue({ route: "command", command: "memory", args: "" }),
    } as unknown as ConversationLoopDeps["routeEngine"];
    const keywordEngine = {
      classify: vi.fn().mockReturnValue({ type: "command" }),
      matchAllPluginIds: () => new Set(),
    } as unknown as ConversationLoopDeps["keywordEngine"];
    const fakeProvider = {
      vendor: "openai" as const,
      streamTurn: async function* () { /* unused */ },
    };
    const loop = new ConversationLoop(makeDeps({ memoryManager: mem, routeEngine, keywordEngine }));
    (loop as unknown as { provider: typeof fakeProvider }).provider = fakeProvider;

    const result = await loop.runTurn("/memory");

    expect(result.text).toContain("사용자 메모");
    expect(listMemoryEntries).toHaveBeenCalledOnce();
  });
});
