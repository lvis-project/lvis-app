/**
 * PR-4 — lvis:chat:get-verbatim-tool-result IPC handler unit tests.
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
  messages: Array<ReturnType<typeof makeToolResultMsg> | Record<string, unknown>>,
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
  registerChatHandlers(makeMinimalDeps(loop, opts) as any);
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
