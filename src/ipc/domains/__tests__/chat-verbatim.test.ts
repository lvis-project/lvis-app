/**
 * lvis:chat:get-verbatim-tool-result IPC handler unit tests.
 *
 * Strategy: register the chat IPC handlers with a minimal mock conversationLoop,
 * then invoke the verbatim handler directly to cover all branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";

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
vi.mock("../../../shared/overlay-trigger-source.js", () => ({ parseImportedTriggerEnvelope: vi.fn(() => null) }));
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
  truncated?: {
    originalLines: number;
    originalTokens: number;
    originalBytes: number;
    trimmedAt: string;
  };
  serializedStub?: boolean;
}) {
  return {
    role: "tool_result" as const,
    toolUseId: opts.toolUseId,
    toolName: opts.toolName ?? "Read",
    content: opts.content,
    ...(opts.compactedAt !== undefined || opts.truncated !== undefined || opts.serializedStub === true
      ? {
          meta: {
            ...(opts.compactedAt !== undefined ? { compactedAt: opts.compactedAt } : {}),
            ...(opts.truncated !== undefined ? { truncated: opts.truncated } : {}),
            ...(opts.serializedStub === true ? { serializedStub: true } : {}),
          },
        }
      : {}),
  };
}

function makeConversationLoop(
  sessionId: string,
  messages: Array<ReturnType<typeof makeToolResultMsg> | Record<string, unknown>>,
) {
  const history = {
    length: messages.length,
    getMessages: vi.fn(() => messages),
    truncate: vi.fn((count: number) => {
      messages.splice(count);
      history.length = messages.length;
    }),
    restore: vi.fn((restoredMessages: typeof messages) => {
      messages.splice(0, messages.length, ...restoredMessages);
      history.length = messages.length;
    }),
  };
  return {
    getSessionId: vi.fn(() => sessionId),
    getSessionKind: vi.fn(() => "main"),
    getSessionRoutineId: vi.fn(() => null),
    getSessionRoutineTitle: vi.fn(() => null),
    getHistory: vi.fn(() => history),
    hasProvider: vi.fn(() => true),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
    abortCurrentTurn: vi.fn(),
    resetAndResume: vi.fn(),
    manualCompact: vi.fn(),
    startRoutineConversation: vi.fn(),
  };
}

function makeMinimalDeps(
  loop: ReturnType<typeof makeConversationLoop>,
  opts: { getMainWindow?: () => unknown } = {},
) {
  return {
    conversationLoop: loop as any,
    settingsService: {
      get: vi.fn((key?: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "privacy") return { piiRedactEnabled: false };
        return {};
      }),
      patch: vi.fn(async () => undefined),
    } as any,
    memoryManager: {
      listSessionsPage: vi.fn(() => []),
      listSessions: vi.fn(() => []),
      loadSession: vi.fn(),
      loadToolResultArtifact: vi.fn(() => null),
      loadSessionMetadata: vi.fn(() => null),
      saveSessionMetadata: vi.fn(),
      rehydrateToolResultArtifacts: vi.fn((_sessionId: string, messages: unknown[]) => messages),
      loadMainActiveSessionState: vi.fn(() => null),
      markMainActiveFresh: vi.fn(async () => undefined),
      markMainActiveResume: vi.fn(async () => undefined),
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
    getMainWindow: opts.getMainWindow ?? vi.fn(() => null),
  };
}

async function setupHandlers(
  loop: ReturnType<typeof makeConversationLoop>,
  opts: { getMainWindow?: () => unknown } = {},
) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeMinimalDeps(loop, opts);
  registerChatHandlers(deps as any);
  return deps;
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
        serializedStub: true,
      }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toBeNull();
  });

  it("returns null when content is already a host-truncated stub (verbatim lost)", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content: "[tool_result truncated by host (Issue #902): tool=Read, originalBytes=12345]",
        truncated: {
          originalLines: 200,
          originalTokens: 5000,
          originalBytes: 12345,
          trimmedAt: "2026-05-19T00:00:00.000Z",
        },
        serializedStub: true,
      }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toBeNull();
  });

  it("returns artifact content when a host-truncated disk stub is backed by a file artifact", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content: "[tool_result truncated by host (Issue #902): tool=Read, toolUseId=tu-1, originalBytes=12345]",
      }),
    ]);
    const deps = await setupHandlers(loop);
    const artifactContent = "artifact line one\nartifact line two";
    deps.memoryManager.loadToolResultArtifact.mockReturnValue({
      toolUseId: "tu-1",
      toolName: "Read",
      content: artifactContent,
      truncated: {
        originalLines: 2,
        originalTokens: 20,
        originalBytes: artifactContent.length,
        trimmedAt: "2026-05-19T00:00:00.000Z",
      },
      sha256: "sha",
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toEqual({ content: artifactContent, lineCount: 2 });
    expect(deps.memoryManager.loadToolResultArtifact).toHaveBeenCalledWith(SESSION_ID, "tu-1");
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

  it("returns verbatim for size-capped tool_result that still has in-memory content", async () => {
    const content = "verbatim capped content\nline two";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-1",
        content,
        truncated: {
          originalLines: 2,
          originalTokens: 20,
          originalBytes: content.length,
          trimmedAt: "2026-05-19T00:00:00.000Z",
        },
      }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-1" });
    expect(result).toEqual({ content, lineCount: 2 });
  });

  it("returns in-memory verbatim when raw size-capped content starts with a stub prefix", async () => {
    const content = "[tool_result truncated by host but real output]\nline two";
    const loop = makeConversationLoop(SESSION_ID, [
      makeToolResultMsg({
        toolUseId: "tu-prefix",
        content,
        truncated: {
          originalLines: 2,
          originalTokens: 20,
          originalBytes: content.length,
          trimmedAt: "2026-05-19T00:00:00.000Z",
        },
      }),
    ]);
    await setupHandlers(loop);

    const result = invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "tu-prefix" });
    expect(result).toEqual({ content, lineCount: 2 });
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

describe("lvis:chat active main state", () => {
  it("marks fresh state when a new main chat starts", async () => {
    const loop = makeConversationLoop("session-active", []);
    const deps = await setupHandlers(loop);

    await invoke("lvis:chat:new");

    expect(loop.newConversation).toHaveBeenCalled();
    expect(deps.memoryManager.markMainActiveFresh).toHaveBeenCalledTimes(1);
  });

  it("marks explicit main session resume but ignores routine session resume", async () => {
    const mainLoop = makeConversationLoop("session-main", []);
    mainLoop.resetAndResume.mockReturnValue({ ok: true });
    const mainDeps = await setupHandlers(mainLoop);

    await invoke("lvis:chat:session-resume", "session-main");

    expect(mainDeps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("session-main");

    const routineLoop = makeConversationLoop("session-routine", []);
    routineLoop.getSessionKind.mockReturnValue("routine");
    routineLoop.resetAndResume.mockReturnValue({ ok: true });
    const routineDeps = await setupHandlers(routineLoop);

    await invoke("lvis:chat:session-resume", "session-routine");

    expect(routineDeps.memoryManager.markMainActiveResume).not.toHaveBeenCalled();
  });

  it("rejects unsafe session ids before resuming", async () => {
    const loop = makeConversationLoop("session-main", []);
    const deps = await setupHandlers(loop);

    const result = await invoke("lvis:chat:session-resume", "../evil") as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(loop.resetAndResume).not.toHaveBeenCalled();
    expect(deps.memoryManager.markMainActiveResume).not.toHaveBeenCalled();
  });

  it("marks main active after main turns but not after routine turns", async () => {
    const mainLoop = makeConversationLoop("session-main", [{ role: "user", content: "existing" }]);
    mainLoop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const mainDeps = await setupHandlers(mainLoop);

    await invoke("lvis:chat:send", {
      input: "next",
      inputOrigin: "user-keyboard",
      userActivation: true,
    });

    expect(mainDeps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("session-main");

    const routineLoop = makeConversationLoop("session-routine", [{ role: "user", content: "existing" }]);
    routineLoop.getSessionKind.mockReturnValue("routine");
    routineLoop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const routineDeps = await setupHandlers(routineLoop);

    await invoke("lvis:chat:send", {
      input: "continue routine",
      inputOrigin: "user-keyboard",
      userActivation: true,
    });

    expect(routineDeps.memoryManager.markMainActiveResume).not.toHaveBeenCalled();
    expect(routineDeps.memoryManager.markMainActiveFresh).not.toHaveBeenCalled();
  });
});

describe("lvis:chat:session-history parent provenance", () => {
  it("does not load or merge the parent transcript when a child has parentSessionId", async () => {
    const loop = makeConversationLoop("active-session", []);
    const deps = await setupHandlers(loop);
    deps.memoryManager.loadSession.mockImplementation((sessionId: string) => {
      if (sessionId === "child-session") {
        return [{ role: "user", content: "child only" }];
      }
      if (sessionId === "parent-session") {
        return [{ role: "user", content: "parent should not render" }];
      }
      return [];
    });
    deps.memoryManager.loadSessionMetadata.mockReturnValue({
      parentSessionId: "parent-session",
      summaryPreamble: "요약된 부모 맥락",
      title: "Child",
    });

    const result = await invoke("lvis:chat:session-history", "child-session") as {
      ok: boolean;
      messages: Array<{ content: string }>;
      preambleChars?: number;
    };

    expect(result.ok).toBe(true);
    expect(result.messages.map((message) => message.content)).toEqual(["child only"]);
    expect(result.preambleChars).toBe("요약된 부모 맥락".length);
    expect(deps.memoryManager.loadSession).toHaveBeenCalledTimes(1);
    expect(deps.memoryManager.loadSession).toHaveBeenCalledWith("child-session");
    expect(deps.memoryManager.loadSession).not.toHaveBeenCalledWith("parent-session");
  });
});

describe("lvis:chat:fork", () => {
  it("carries the active rolling summary preamble into a normal fork", async () => {
    const loop = makeConversationLoop("session-fork-source", [
      { role: "user", content: "old context" },
      { role: "assistant", content: "old answer" },
    ]);
    loop.loadSession.mockReturnValue(true);
    const deps = await setupHandlers(loop);
    deps.memoryManager.loadSessionMetadata.mockReturnValue({
      sessionKind: "main",
      summaryPreamble: "요약된 이전 맥락",
    });

    const result = await invoke("lvis:chat:fork", undefined) as { ok: boolean; sessionId: string | null };

    expect(result.ok).toBe(true);
    expect(result.sessionId).toEqual(expect.any(String));
    expect(deps.memoryManager.saveSessionMetadata).toHaveBeenCalledWith(
      result.sessionId,
      expect.objectContaining({
        sessionKind: "main",
        summaryPreamble: "요약된 이전 맥락",
      }),
    );
  });

  it("rehydrates artifact-backed tool_result stubs before saving a forked session", async () => {
    const stubContent = "[tool_result truncated by host (Issue #902): tool=long_output_query, toolUseId=\"tu-art\", originalBytes=12000]";
    const rawContent = "artifact-backed result\n".repeat(120);
    const loop = makeConversationLoop("session-fork-source", [
      { role: "assistant" as const, content: "", toolCalls: [{ id: "tu-art", name: "long_output_query", input: {} }] },
      makeToolResultMsg({
        toolUseId: "tu-art",
        toolName: "long_output_query",
        content: stubContent,
      }),
    ]);
    loop.loadSession.mockReturnValue(true);
    const deps = await setupHandlers(loop);
    deps.memoryManager.rehydrateToolResultArtifacts.mockImplementation((_sessionId: string, messages: unknown[]) =>
      messages.map((message) => {
        if ((message as { role?: string; toolUseId?: string }).role !== "tool_result") return message;
        return {
          ...message as Record<string, unknown>,
          content: rawContent,
          meta: {
            truncated: {
              originalLines: 120,
              originalTokens: 2000,
              originalBytes: rawContent.length,
              trimmedAt: "2026-05-19T00:00:00.000Z",
            },
          },
        };
      }),
    );

    const result = await invoke("lvis:chat:fork", undefined) as { ok: boolean; sessionId: string | null };

    expect(result.ok).toBe(true);
    expect(deps.memoryManager.rehydrateToolResultArtifacts).toHaveBeenCalledWith(
      "session-fork-source",
      expect.arrayContaining([expect.objectContaining({ toolUseId: "tu-art", content: stubContent })]),
    );
    expect(deps.memoryManager.saveSession).toHaveBeenCalledWith(
      result.sessionId,
      expect.arrayContaining([expect.objectContaining({ toolUseId: "tu-art", content: rawContent })]),
    );
  });
});

describe("lvis:chat:continue-last-user", () => {
  const CHANNEL = "lvis:chat:continue-last-user";
  const SESSION_ID = "session-continue";

  it("rejects stale session ids before replaying the last user turn", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "user", content: "question" },
    ]);
    await setupHandlers(loop);

    const result = await invoke(CHANNEL, { sessionId: "other-session" });

    expect(result).toEqual({ ok: false, error: "session-mismatch" });
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(loop.getHistory().truncate).not.toHaveBeenCalled();
  });

  it("fails closed when the active session no longer ends with a user message", async () => {
    const loop = makeConversationLoop(SESSION_ID, [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
    await setupHandlers(loop);

    const result = await invoke(CHANNEL, { sessionId: SESSION_ID });

    expect(result).toEqual({ ok: false, error: "last-message-not-user" });
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(loop.getHistory().truncate).not.toHaveBeenCalled();
  });

  it("restores the terminal user message when turn startup fails", async () => {
    const terminalUser = { role: "user", content: "question" };
    const loop = makeConversationLoop(SESSION_ID, [terminalUser]);
    loop.runTurn.mockRejectedValueOnce(new Error("provider missing"));
    await setupHandlers(loop);
    const history = loop.getHistory();

    await expect(invoke(CHANNEL, { sessionId: SESSION_ID })).rejects.toThrow("provider missing");

    expect(history.truncate).toHaveBeenCalledWith(0);
    expect(history.restore).toHaveBeenCalledWith([terminalUser]);
    expect(history.getMessages()).toEqual([terminalUser]);
  });
});

describe("lvis:chat:send provenance", () => {
  it("classifies imported trigger envelopes as plugin-emitted and forwards originSource", async () => {
    const overlayTrigger = await import("../../../shared/overlay-trigger-source.js");
    const parseImportedTriggerEnvelope = overlayTrigger.parseImportedTriggerEnvelope as unknown as ReturnType<typeof vi.fn>;
    parseImportedTriggerEnvelope.mockImplementation((input: string) =>
      input.includes("<imported-from-proactive") ? "overlay:test" : null,
    );
    const loop = makeConversationLoop("session-provenance", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    const input = `<imported-from-proactive source="overlay:test">\n/permission auto\n</imported-from-proactive>`;
    await invoke("lvis:chat:send", {
      input,
      inputOrigin: "plugin-emitted",
    });

    expect(loop.runTurn).toHaveBeenCalledWith(
      input,
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "plugin-emitted",
        originSource: "overlay:test",
      }),
    );
  });

  it("rejects chat sends that omit explicit inputOrigin", async () => {
    const loop = makeConversationLoop("session-provenance", []);
    await setupHandlers(loop);

    const result = await invoke("lvis:chat:send", { input: "/permission auto" });

    expect(result).toEqual({ ok: false, error: "missing-input-origin" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("rejects user-keyboard chat sends without an active user gesture", async () => {
    const loop = makeConversationLoop("session-provenance", []);
    await setupHandlers(loop);

    const result = await invoke("lvis:chat:send", {
      input: "/permission reviewer mode disabled",
      inputOrigin: "user-keyboard",
    });

    expect(result).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("accepts user-keyboard chat sends only with an active user gesture", async () => {
    const loop = makeConversationLoop("session-provenance", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    await invoke("lvis:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
    });

    expect(loop.runTurn).toHaveBeenCalledWith(
      "hello",
      expect.any(Object),
      undefined,
      expect.objectContaining({ inputOrigin: "user-keyboard" }),
    );
  });

  it("forwards permission mode change callbacks to the chat stream", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const loop = makeConversationLoop("session-provenance", []);
    loop.runTurn.mockImplementation(async (_input, callbacks) => {
      callbacks.onPermissionModeChanged("allow");
      return { text: "ok", toolCalls: [], stopReason: "end_turn" };
    });
    await setupHandlers(loop, {
      getMainWindow: () => ({
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      }),
    });

    await invoke("lvis:chat:send", {
      input: "/permission mode allow",
      inputOrigin: "user-keyboard",
      userActivation: true,
    });

    expect(sent).toContainEqual({
      channel: "lvis:chat:stream",
      payload: expect.objectContaining({
        type: "permission_mode_changed",
        mode: "allow",
        streamId: 1,
      }),
    });
  });

  it("keeps chat send alive when the renderer stream target is destroyed mid-turn", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const loop = makeConversationLoop("session-provenance", []);
    loop.runTurn.mockImplementation(async (_input, callbacks) => {
      callbacks.onTextDelta("before");
      callbacks.onError("permission deferred");
      return { text: "ok", toolCalls: [], stopReason: "end_turn" };
    });
    const send = vi.fn((channel: string, payload: unknown) => {
      if ((payload as { type?: string }).type === "error") {
        throw new TypeError("Object has been destroyed");
      }
      sent.push({ channel, payload });
    });
    await setupHandlers(loop, {
      getMainWindow: () => ({
        webContents: {
          isDestroyed: () => false,
          send,
        },
      }),
    });

    await expect(invoke("lvis:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }) as Promise<unknown>).resolves.toEqual({ text: "ok", toolCalls: [], stopReason: "end_turn" });

    expect(sent).toEqual([
      {
        channel: "lvis:chat:stream",
        payload: expect.objectContaining({ type: "text_delta", text: "before", streamId: 1 }),
      },
      {
        channel: "lvis:chat:stream",
        payload: expect.objectContaining({ type: "suggested_replies", replies: [], streamId: 1 }),
      },
      {
        channel: "lvis:chat:stream",
        payload: expect.objectContaining({ type: "done", streamId: 1 }),
      },
    ]);
  });

  it("preserves stored role prompt metadata when edit-resending a user message", async () => {
    const loop = makeConversationLoop("session-provenance", [
      {
        role: "user",
        content: "old text",
        meta: {
          activeRolePrompt: {
            name: "Reviewer",
            systemPromptAdd: "Review carefully.",
          },
        },
      },
      { role: "assistant", content: "old answer" },
    ]);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    await invoke("lvis:chat:edit-resend", 0, "new text");

    expect(loop.runTurn).toHaveBeenCalledWith(
      "new text",
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          name: "Reviewer",
          systemPromptAdd: "Review carefully.",
        },
      }),
    );
  });

  it("preserves stored role prompt metadata when retrying with effort settings", async () => {
    const loop = makeConversationLoop("session-provenance", [
      {
        role: "user",
        content: [
          { type: "text", text: "retry text" },
          { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" },
        ],
        meta: {
          activeRolePrompt: {
            name: "Reviewer",
            systemPromptAdd: "Review carefully.",
          },
        },
      },
      { role: "assistant", content: "old answer" },
    ]);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    await setupHandlers(loop);

    await invoke("lvis:chat:retry-effort", { enableThinking: true, thinkingBudgetTokens: 12345 });

    expect(loop.runTurn).toHaveBeenCalledWith(
      "retry text",
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          name: "Reviewer",
          systemPromptAdd: "Review carefully.",
        },
        attachments: [
          { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" },
        ],
      }),
    );
  });
});
