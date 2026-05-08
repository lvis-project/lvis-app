/**
 * PR-4 — lvis:chat:get-verbatim-tool-result IPC handler unit tests.
 *
 * Strategy: register the chat IPC handlers with a minimal mock conversationLoop,
 * then invoke the verbatim handler directly to cover all branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock electron ────────────────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// ─── Mock audit/DLP (not under test) ─────────────────────────────────────────
vi.mock("../../../audit/dlp-filter.js", () => ({
  redactForLLM: vi.fn((s: string) => ({ redacted: s, totalCount: 0, counts: {} })),
  redactFsPath: vi.fn((s: string) => s),
  redactAuditPayload: vi.fn((p: unknown) => p),
  maskSensitiveData: vi.fn((s: string) => ({ masked: s, findings: [] })),
  initDlpAudit: vi.fn(),
}));
vi.mock("../../../engine/wire-serialize.js", () => ({ stubMarkedToolResults: vi.fn((m: unknown) => m) }));
vi.mock("../../../engine/proactive-source.js", () => ({ parseImportedTriggerEnvelope: vi.fn(() => null) }));
vi.mock("../../../routines/registry.js", () => ({
  REGISTERED_ROUTINES: [],
  buildRoutineForTrigger: vi.fn(),
  getRegisteredRoutine: vi.fn(),
}));
vi.mock("../../../routines/schedule.js", () => ({
  DEFAULT_SHUTDOWN_PROMPT: "",
  DEFAULT_WAKEUP_ROUTINE_PROMPT: "",
  MAX_SCHEDULE_ENTRIES: 10,
  scheduleToCron: vi.fn(),
  isValidScheduleEntries: vi.fn(() => true),
  normalizeScheduleEntries: vi.fn((e: unknown) => e ?? []),
}));
vi.mock("../../../routines/routine-delivery.js", () => ({
  clearLatestRoutineResult: vi.fn(),
  getLatestRoutineResult: vi.fn(() => null),
}));
vi.mock("../../../boot/dev-flags.js", () => ({ isDevModeUnlocked: vi.fn(() => false) }));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));
vi.mock("../../../shared/chat-history.js", () => ({
  serializeHistoryMessage: vi.fn((m: unknown, i: number) => ({ ...m as object, index: i })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal GenericMessage-compatible tool_result message */
function makeToolResultMsg(opts: {
  toolUseId: string;
  content: string;
  toolName?: string;
  compactedAt?: string;
}) {
  return {
    role: "tool_result" as const,
    toolUseId: opts.toolUseId,
    toolName: opts.toolName ?? "Read",
    content: opts.content,
    ...(opts.compactedAt !== undefined
      ? { meta: { compactedAt: opts.compactedAt } }
      : {}),
  };
}

function makeConversationLoop(
  sessionId: string,
  messages: ReturnType<typeof makeToolResultMsg>[],
) {
  return {
    getSessionId: vi.fn(() => sessionId),
    getHistory: vi.fn(() => ({
      getMessages: vi.fn(() => messages),
      truncate: vi.fn(),
    })),
    hasProvider: vi.fn(() => true),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    listSessions: vi.fn(() => []),
    listRoutineSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
    abortCurrentTurn: vi.fn(),
    resetAndResume: vi.fn(),
    manualCompact: vi.fn(),
    startRoutineConversation: vi.fn(),
  };
}

function makeMinimalDeps(loop: ReturnType<typeof makeConversationLoop>) {
  return {
    conversationLoop: loop as any,
    settingsService: {
      get: vi.fn(() => ({})),
      patch: vi.fn(),
    } as any,
    memoryManager: {
      listSessionsPage: vi.fn(() => []),
      loadSession: vi.fn(),
      loadSessionMetadata: vi.fn(() => null),
      saveSession: vi.fn(),
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      searchSessions: vi.fn(() => []),
      getLvisMd: vi.fn(),
      updateLvisMd: vi.fn(),
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
      listSessionEntries: vi.fn(() => []),
    } as any,
    routineEngine: undefined,
    triggerExecutor: undefined,
    starredStore: undefined,
    feedbackStore: undefined,
    auditLogger: { log: vi.fn() } as any,
    askUserQuestionGate: undefined,
    notificationService: undefined,
    getMainWindow: vi.fn(() => null),
  };
}

async function setupHandlers(
  loop: ReturnType<typeof makeConversationLoop>,
) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  registerChatHandlers(makeMinimalDeps(loop) as any);
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(null, ...args);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("lvis:chat:get-verbatim-tool-result", () => {
  const CHANNEL = "lvis:chat:get-verbatim-tool-result";
  const SESSION_ID = "session-abc";

  it("returns verbatim content + lineCount for matching in-session tool_result", async () => {
    const content = "line1\nline2\nline3";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content, compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toEqual({ content, lineCount: 3 });
  });

  it("returns null when sessionId does not match active session", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content: "some content" }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: "other-session", toolUseId: "tu-1" });
    expect(result).toBeNull();
  });

  it("returns null when toolUseId not found in history", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content: "some content" }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-UNKNOWN" });
    expect(result).toBeNull();
  });

  it("returns null when content is already a stub (verbatim lost)", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content: "[tool_result stripped: tool=Read, origLen=12345]",
        compactedAt: "2026-05-08T00:00:00Z",
      }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toBeNull();
  });

  it("returns null for non-compacted tool_result (meta.compactedAt not set)", async () => {
    // A tool_result that was never compacted should NOT be served via this IPC.
    // Only messages that have gone through the compact pipeline are valid callers.
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-1", content: "verbatim content no compact" }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toBeNull();
  });

  it("returns verbatim for compacted tool_result that still has verbatim content", async () => {
    // compactedAt is set (message went through compact) but content is still the
    // verbatim (in-memory, not yet serialized as stub).
    const content = "verbatim still present\nline two";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content,
        compactedAt: "2026-05-08T01:00:00Z",
      }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toEqual({ content, lineCount: 2 });
  });

  it("computes lineCount accurately for multi-line content", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-50", content, compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-50" }) as {
      content: string;
      lineCount: number;
    };
    expect(result).not.toBeNull();
    expect(result.lineCount).toBe(50);
    expect(result.content).toBe(content);
  });

  it("returns lineCount of 1 for single-line content", async () => {
    const content = "single line no newline";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({ toolUseId: "tu-single", content, compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-single" }) as {
      content: string;
      lineCount: number;
    };
    expect(result).not.toBeNull();
    expect(result.lineCount).toBe(1);
  });

  it("matches the first tool_result when history has multiple messages", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "user" as const, content: "hello" } as any,
      { role: "assistant" as const, content: "I'll read it" } as any,
      makeToolResultMsg({ toolUseId: "tu-A", content: "content-A", compactedAt: "2026-05-08T00:00:00Z" }),
      makeToolResultMsg({ toolUseId: "tu-B", content: "content-B", compactedAt: "2026-05-08T00:00:00Z" }),
    ]);
    await setupHandlers(loop);

    const resultA = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-A" });
    const resultB = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-B" });
    expect((resultA as any).content).toBe("content-A");
    expect((resultB as any).content).toBe("content-B");
  });
});
