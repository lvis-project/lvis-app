/**
 * lvis:chat:get-verbatim-tool-result IPC handler unit tests.
 *
 * Strategy: register the chat IPC handlers with a minimal mock conversationLoop,
 * then invoke the verbatim handler directly to cover all branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdirSync, realpathSync } from "node:fs";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { invokeRegisteredHandler } from "../../../__tests__/test-helpers.js";

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
// Authorize one extra explicit project (on top of whatever the real settings
// file already grants) so the "explicit project persists metadata" test below
// can exercise the REAL resolveAuthorizedWorkspaceProject/listAuthorizedWorkspaceProjects
// path end-to-end instead of stubbing the authorization decision itself.
// Preserves every other field via importOriginal — only additionalDirectories
// is extended, so the default-only tests elsewhere in this file are unaffected.
// Built via the real, OS-native `path.resolve` (not a hardcoded Windows-style
// literal) so it round-trips identically through BOTH of the two independent
// canonicalization systems this test's authorization path touches:
// `sanitizeRuntimeAllowedDirectories`/`canonicalizePathForMatch` (real
// `path.resolve()` + `realpathSync` — genuinely OS-native, correctly so,
// since it backs real filesystem permission scoping) and
// `projectRootEquals`/`projectRootKey` (pure string normalization). A
// drive-letter literal like "C:\\workspace\\explicit-project" is absolute on
// Windows but NOT on POSIX, so `path.resolve()` silently prefixes
// `process.cwd()` to it on Linux — the two systems then disagree on the
// canonical form and `resolveAuthorizedWorkspaceProject` fails to find the
// entry, making the "explicit project persists metadata" assertion below
// flip to 0 calls on Linux CI while passing on a Windows dev machine.
const EXPLICIT_TEST_PROJECT_ROOT = path.resolve(os.tmpdir(), "lvis-explicit-project-fixture");
vi.mock("../../../permissions/permission-settings-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/permission-settings-store.js")>();
  return {
    ...actual,
    readPermissionSettings: vi.fn((...args: Parameters<typeof actual.readPermissionSettings>) => {
      const real = actual.readPermissionSettings(...args);
      return {
        ...real,
        permissions: {
          ...real.permissions,
          additionalDirectories: [...(real.permissions.additionalDirectories ?? []), EXPLICIT_TEST_PROJECT_ROOT],
        },
      };
    }),
  };
});

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
    // markMainActiveAfterTurn calls this unconditionally (no duck-typing —
    // it's a real, always-present ConversationLoop method). Defaults to
    // `false` (not the default project) so the existing "persists project
    // identity" expectations in this file keep working unchanged; override
    // per-test via `loop.getSessionProjectIsDefault.mockReturnValue(true)`.
    getSessionProjectIsDefault: vi.fn(() => false),
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
  opts: { getMainWindow?: () => unknown; personaPromptStore?: unknown; getSubAgentRunner?: () => unknown } = {},
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
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
      listSessionEntries: vi.fn(() => []),
    } as any,
    routineEngine: undefined,
    triggerExecutor: undefined,
    starredStore: undefined,
    feedbackStore: undefined,
    auditLogger: { log: vi.fn() } as any,
    personaPromptStore: opts.personaPromptStore,
    getSubAgentRunner: opts.getSubAgentRunner,
    askUserQuestionGate: undefined,
    notificationService: undefined,
    getMainWindow: opts.getMainWindow ?? vi.fn(() => null),
  };
}

async function setupHandlers(
  loop: ReturnType<typeof makeConversationLoop>,
  opts: { getMainWindow?: () => unknown; personaPromptStore?: unknown; getSubAgentRunner?: () => unknown } = {},
) {
  handlers.clear();
  vi.clearAllMocks();
  const { registerChatHandlers } = await import("../chat.js");
  const deps = makeMinimalDeps(loop, opts);
  registerChatHandlers(deps as any);
  return deps;
}

function invoke(channel: string, ...args: unknown[]): unknown {
  return invokeRegisteredHandler(handlers, channel, ...args);
}

class SessionMutationGate<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
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

describe("lvis:chat:get-sub-agent-transcript", () => {
  const CHANNEL = "lvis:chat:get-sub-agent-transcript";
  const SESSION_ID = "session-abc";

  function makeAgentSpawnMessages() {
    return [
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [
          {
            id: "tu-agent",
            name: "agent_spawn",
            input: { title: "Research", instructions: "collect", resumeId: "child-resume" },
          },
        ],
      },
      {
        role: "tool_result" as const,
        toolUseId: "tu-agent",
        toolName: "agent_spawn",
        content: JSON.stringify({
          spawnId: "spawn-live",
          childSessionId: "child-1",
          summary: "done",
        }),
      },
    ];
  }

  it("hydrates only when the active parent transcript contains the requested sub-agent reference", async () => {
    const getPersistedTranscript = vi.fn(() => ({
      ok: true,
      childSessionId: "child-1",
      messages: [{ role: "assistant", content: "done" }],
    }));
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invoke(CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "child-1",
    });

    expect(result).toEqual({
      ok: true,
      childSessionId: "child-1",
      messages: [{ role: "assistant", content: "done" }],
    });
    expect(getPersistedTranscript).toHaveBeenCalledWith({
      originSessionId: SESSION_ID,
      childSessionId: "child-1",
    });
  });

  it("rejects toolUseId/spawnId-only requests instead of reconstructing a legacy child lookup", async () => {
    const getPersistedTranscript = vi.fn();
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invoke(CHANNEL, {
      originSessionId: SESSION_ID,
      toolUseId: "tu-agent",
      spawnId: "spawn-live",
    });

    expect(result).toEqual({ ok: false, error: "invalid-child-session-id" });
    expect(getPersistedTranscript).not.toHaveBeenCalled();
  });

  it("uses childSessionId alone when a grouped sub-agent row has a direct child link", async () => {
    const getPersistedTranscript = vi.fn(() => ({
      ok: true,
      childSessionId: "child-1",
      messages: [{ role: "assistant", content: "done" }],
    }));
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invoke(CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "child-1",
    });

    expect(result).toEqual({
      ok: true,
      childSessionId: "child-1",
      messages: [{ role: "assistant", content: "done" }],
    });
    expect(getPersistedTranscript).toHaveBeenCalledWith({
      originSessionId: SESSION_ID,
      childSessionId: "child-1",
    });
  });

  it("uses artifact-rehydrated parent agent_spawn handles for the childSessionId gate", async () => {
    const getPersistedTranscript = vi.fn(() => ({
      ok: true,
      childSessionId: "child-artifact",
      messages: [{ role: "assistant", content: "artifact-backed child transcript" }],
    }));
    const messages = makeAgentSpawnMessages();
    messages[0] = {
      ...(messages[0] as any),
      toolCalls: [
        {
          id: "tu-agent",
          name: "agent_spawn",
          input: { title: "Research", instructions: "collect" },
        },
      ],
    };
    messages[1] = {
      ...(messages[1] as any),
      content: "[tool_result stripped: tool=agent_spawn, origLen=2048]",
    };
    const loop = makeConversationLoop(SESSION_ID, messages);
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });
    deps.memoryManager.rehydrateToolResultArtifacts.mockImplementation((_sessionId: string, raw: unknown[]) =>
      raw.map((message) =>
        (message as any).role === "tool_result" && (message as any).toolUseId === "tu-agent"
          ? {
              ...(message as any),
              content: JSON.stringify({
                childSessionId: "child-artifact",
                summary: "done",
              }),
            }
          : message,
      ),
    );

    const result = invoke(CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "child-artifact",
    });

    expect(deps.memoryManager.rehydrateToolResultArtifacts).toHaveBeenCalledWith(SESSION_ID, expect.any(Array));
    expect(result).toEqual({
      ok: true,
      childSessionId: "child-artifact",
      messages: [{ role: "assistant", content: "artifact-backed child transcript" }],
    });
  });


  it("rejects requests for a non-active parent session before runner lookup", async () => {
    const getPersistedTranscript = vi.fn();
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invoke(CHANNEL, {
      originSessionId: "other-session",
      childSessionId: "child-1",
    });

    expect(result).toEqual({ ok: false, error: "origin-session-not-active" });
    expect(getPersistedTranscript).not.toHaveBeenCalled();
  });

  it("rejects an unrelated childSessionId", async () => {
    const getPersistedTranscript = vi.fn();
    const loop = makeConversationLoop(SESSION_ID, makeAgentSpawnMessages());
    await setupHandlers(loop, { getSubAgentRunner: () => ({ getPersistedTranscript }) });

    const result = invoke(CHANNEL, {
      originSessionId: SESSION_ID,
      childSessionId: "child-from-another-run",
    });

    expect(result).toEqual({ ok: false, error: "sub-agent-reference-not-found" });
    expect(getPersistedTranscript).not.toHaveBeenCalled();
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

  it("does NOT persist project metadata for a plain new chat (no explicit project — the default binding)", async () => {
    // 2026-07 "remove Current Project labeling": a session created with no
    // explicit project runs against the default/base-directory binding
    // internally (conversationLoop.newConversation still applies it for tool
    // access — unaffected by this test) but must NOT be tagged with it in
    // session metadata. "No project" (null fields) is the normal persisted
    // state, so the sidebar renders it ungrouped and Insights buckets it
    // under "No project" rather than a synthetic "default" label.
    const loop = makeConversationLoop("session-active", []);
    const deps = await setupHandlers(loop);

    await invoke("lvis:chat:new");

    expect(deps.memoryManager.saveSessionMetadata).not.toHaveBeenCalled();
  });

  it("persists the resolved project identity when the user explicitly selects a real project", async () => {
    // Contrast case: an EXPLICIT (non-default) project selection still
    // persists metadata at creation — mirrors startRoutineConversation — so
    // the Insights "프로젝트별 대화" group-by can join it immediately without
    // waiting for the first turn to complete.
    mkdirSync(EXPLICIT_TEST_PROJECT_ROOT, { recursive: true });
    const explicitProjectRoot = realpathSync(EXPLICIT_TEST_PROJECT_ROOT);
    const loop = makeConversationLoop("session-active", []);
    const deps = await setupHandlers(loop);

    await invoke("lvis:chat:new", { projectRoot: explicitProjectRoot, projectName: "explicit-project" });

    expect(deps.memoryManager.saveSessionMetadata).toHaveBeenCalledTimes(1);
    const [savedId, savedMeta] = (deps.memoryManager.saveSessionMetadata as any).mock.calls[0];
    expect(savedId).toBe("session-active");
    // sanitizeRuntimeAllowedDirectories normalizes the authorized root's
    // slash/case form — compare case/separator-insensitively rather than
    // asserting the exact literal input string.
    expect(savedMeta.sessionKind).toBe("main");
    expect(savedMeta.projectName).toBe("explicit-project");
    expect((savedMeta.projectRoot as string).toLowerCase().replace(/\\/g, "/")).toBe(
      explicitProjectRoot.toLowerCase().replace(/\\/g, "/"),
    );
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

  it("holds a session-mutation lease across fork persistence awaits", async () => {
    const loop = makeConversationLoop("session-fork-source", [
      { role: "user", content: "source prompt" },
      { role: "assistant", content: "source answer" },
    ]);
    loop.loadSession.mockReturnValue(true);
    const deps = await setupHandlers(loop);
    const firstSaveEntered = new SessionMutationGate<void>();
    const firstSaveGate = new SessionMutationGate<void>();
    let saveCallCount = 0;
    deps.memoryManager.saveSession.mockImplementation(async () => {
      saveCallCount += 1;
      if (saveCallCount === 1) {
        firstSaveEntered.resolve(undefined);
        await firstSaveGate.promise;
      }
    });

    const forkPromise = invoke("lvis:chat:fork", undefined) as Promise<unknown>;

    // The mutation lease is visible before the deferred fork factory starts.
    await expect(invoke("lvis:chat:send", {
      input: "must not enter fork",
      inputOrigin: "user-keyboard",
      userActivation: true,
    })).resolves.toEqual({ error: "streaming-active" });

    await firstSaveEntered.promise;
    await expect(invoke("lvis:chat:new")).resolves.toEqual({
      ok: false,
      error: "streaming-active",
    });
    await expect(invoke("lvis:chat:session-resume", "session-fork-source")).resolves.toEqual(
      expect.objectContaining({ ok: false, error: "streaming-active" }),
    );
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(loop.newConversation).not.toHaveBeenCalled();
    expect(loop.resetAndResume).not.toHaveBeenCalled();

    firstSaveGate.resolve(undefined);
    await expect(forkPromise).resolves.toEqual({
      ok: true,
      sessionId: expect.any(String),
    });
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

  it("resolves personaPromptId through PersonaPromptStore at the chat boundary", async () => {
    const loop = makeConversationLoop("session-provenance", []);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const personaPromptStore = {
      get: vi.fn(async () => ({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Current file prompt.",
      })),
    };
    await setupHandlers(loop, { personaPromptStore });

    await invoke("lvis:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
      personaPromptId: "reviewer",
    });

    expect(personaPromptStore.get).toHaveBeenCalledWith("reviewer");
    expect(loop.runTurn).toHaveBeenCalledWith(
      "hello",
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          id: "reviewer",
          name: "Reviewer",
          systemPromptAdd: "Current file prompt.",
        },
      }),
    );
  });

  it("rejects the original input when the session changes during persona resolution", async () => {
    const loop = makeConversationLoop("session-before-persona", []);
    const personaEntered = new SessionMutationGate<void>();
    const personaGate = new SessionMutationGate<{
      id: string;
      name: string;
      systemPromptAdd: string;
    }>();
    const personaPromptStore = {
      get: vi.fn(() => {
        personaEntered.resolve(undefined);
        return personaGate.promise;
      }),
    };
    const runner = {
      peekParentMailbox: vi.fn(),
      acknowledgeParentMailbox: vi.fn(),
    };
    await setupHandlers(loop, {
      personaPromptStore,
      getSubAgentRunner: () => runner,
    });

    const sendPromise = invoke("lvis:chat:send", {
      input: "must stay in the original session",
      inputOrigin: "user-keyboard",
      userActivation: true,
      personaPromptId: "reviewer",
    }) as Promise<unknown>;

    await personaEntered.promise;
    loop.getSessionId.mockReturnValue("session-after-persona");
    personaGate.resolve({
      id: "reviewer",
      name: "Reviewer",
      systemPromptAdd: "Current file prompt.",
    });

    await expect(sendPromise).resolves.toEqual({
      ok: false,
      error: "session-mismatch",
    });
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(runner.peekParentMailbox).not.toHaveBeenCalled();
  });
  it("fails closed when selected personaPromptId is missing from the prompt store", async () => {
    const loop = makeConversationLoop("session-provenance", []);
    const personaPromptStore = { get: vi.fn(async () => null) };
    await setupHandlers(loop, { personaPromptStore });

    const result = await invoke("lvis:chat:send", {
      input: "hello",
      inputOrigin: "user-keyboard",
      userActivation: true,
      personaPromptId: "deleted",
    });

    expect(result).toEqual({ ok: false, error: "persona-prompt-not-found" });
    expect(loop.runTurn).not.toHaveBeenCalled();
  });

  it("rejects personaPromptId on queue-auto chat sends", async () => {
    const loop = makeConversationLoop("session-provenance", []);
    const personaPromptStore = { get: vi.fn() };
    await setupHandlers(loop, { personaPromptStore });

    const result = await invoke("lvis:chat:send", {
      input: "queued follow-up",
      inputOrigin: "queue-auto",
      personaPromptId: "reviewer",
    });

    expect(result).toEqual({ ok: false, error: "persona-prompt-origin-restricted" });
    expect(personaPromptStore.get).not.toHaveBeenCalled();
    expect(loop.runTurn).not.toHaveBeenCalled();
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

  it("resolves stored persona prompt id when edit-resending a user message", async () => {
    const loop = makeConversationLoop("session-provenance", [
      {
        role: "user",
        content: "old text",
        meta: {
          activePersonaPrompt: {
            id: "reviewer",
            name: "Reviewer",
          },
        },
      },
      { role: "assistant", content: "old answer" },
    ]);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const personaPromptStore = {
      get: vi.fn(async () => ({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Current file prompt.",
      })),
    };
    await setupHandlers(loop, { personaPromptStore });

    await invoke("lvis:chat:edit-resend", 0, "new text");

    expect(loop.runTurn).toHaveBeenCalledWith(
      "new text",
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          id: "reviewer",
          name: "Reviewer",
          systemPromptAdd: "Current file prompt.",
        },
      }),
    );
  });

  it("resolves stored persona prompt id when retrying with effort settings", async () => {
    const loop = makeConversationLoop("session-provenance", [
      {
        role: "user",
        content: [
          { type: "text", text: "retry text" },
          { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" },
        ],
        meta: {
          activePersonaPrompt: {
            id: "reviewer",
            name: "Reviewer",
          },
        },
      },
      { role: "assistant", content: "old answer" },
    ]);
    loop.runTurn.mockResolvedValue({ text: "ok", toolCalls: [], stopReason: "end_turn" });
    const personaPromptStore = {
      get: vi.fn(async () => ({
        id: "reviewer",
        name: "Reviewer",
        systemPromptAdd: "Current file prompt.",
      })),
    };
    await setupHandlers(loop, { personaPromptStore });

    await invoke("lvis:chat:retry-effort", { enableThinking: true, thinkingBudgetTokens: 12345 });

    expect(loop.runTurn).toHaveBeenCalledWith(
      "retry text",
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        rolePrompt: {
          id: "reviewer",
          name: "Reviewer",
          systemPromptAdd: "Current file prompt.",
        },
        attachments: [
          { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" },
        ],
      }),
    );
  });
});

describe("sub-agent parent mailbox on manual turns", () => {
  it("joins durable child messages into the user's next parent turn and acknowledges them", async () => {
    const loop = makeConversationLoop("parent-session", []);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      peekParentMailbox: vi.fn(async () => [{
        id: "message-1",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    await invoke("lvis:chat:send", {
      input: "What changed?",
      inputOrigin: "user-keyboard",
      userActivation: true,
    });

    expect(loop.runTurn).toHaveBeenCalledWith(
      "What changed?",
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "user-keyboard",
        initialGuidance: "[Sub-Agent: Researcher]\nfinished",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      }),
    );
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith("parent-session", ["message-1"]);
  });

  it("acknowledges a consumed mailbox before post-turn bookkeeping fails", async () => {
    const loop = makeConversationLoop("parent-session", [
      { role: "user", content: "existing parent input" },
    ]);
    loop.getSessionProjectIsDefault.mockReturnValue(true);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      peekParentMailbox: vi.fn(async () => [{
        id: "message-bookkeeping-failure",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    deps.memoryManager.markMainActiveResume.mockRejectedValueOnce(
      new Error("main-active-bookkeeping-failed"),
    );

    await expect(invoke("lvis:chat:send", {
      input: "Consume child result",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }) as Promise<unknown>).rejects.toThrow("main-active-bookkeeping-failed");

    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith(
      "parent-session",
      ["message-bookkeeping-failure"],
    );
    expect(deps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("parent-session");
    expect(acknowledgeParentMailbox.mock.invocationCallOrder[0])
      .toBeLessThan(deps.memoryManager.markMainActiveResume.mock.invocationCallOrder[0]!);
  });
  it("holds the turn lease from mailbox peek through ACK and blocks session mutation", async () => {
    const loop = makeConversationLoop("parent-session", []);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    const peekGate = new SessionMutationGate<Array<{ id: string; formattedText: string; approvalLabel: string }>>();
    const peekEntered = new SessionMutationGate<void>();
    const ackGate = new SessionMutationGate<number>();
    const ackEntered = new SessionMutationGate<void>();
    let reentrantNew: Promise<unknown> | undefined;
    const runner = {
      peekParentMailbox: vi.fn(() => {
        // This re-entrant mutation observes whether trackStreamTurn published
        // its lease before executing the mailbox factory.
        reentrantNew = invoke("lvis:chat:new") as Promise<unknown>;
        peekEntered.resolve(undefined);
        return peekGate.promise;
      }),
      acknowledgeParentMailbox: vi.fn(() => {
        ackEntered.resolve(undefined);
        return ackGate.promise;
      }),
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });

    const sendPromise = invoke("lvis:chat:send", {
      input: "Consume child result",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }) as Promise<unknown>;

    await peekEntered.promise;
    await expect(reentrantNew).resolves.toEqual({ ok: false, error: "streaming-active" });
    await expect(invoke("lvis:chat:session-resume", "parent-session")).resolves.toEqual(
      expect.objectContaining({ ok: false, error: "streaming-active" }),
    );
    await expect(invoke("lvis:chat:fork", undefined)).resolves.toEqual({
      ok: false,
      sessionId: null,
      error: "streaming-active",
    });
    expect(loop.newConversation).not.toHaveBeenCalled();
    expect(loop.resetAndResume).not.toHaveBeenCalled();
    expect(deps.memoryManager.saveSession).not.toHaveBeenCalled();

    peekGate.resolve([{
      id: "message-lease",
      formattedText: "[Sub-Agent: Researcher]\nfinished",
      approvalLabel: "[Sub-Agent: Researcher]",
    }]);
    await ackEntered.promise;

    // ACK is part of the same lease, so switching sessions is still forbidden
    // after the LLM turn has returned but before durable removal completes.
    await expect(invoke("lvis:chat:new")).resolves.toEqual({
      ok: false,
      error: "streaming-active",
    });
    expect(loop.newConversation).not.toHaveBeenCalled();

    ackGate.resolve(1);
    await sendPromise;
    expect(runner.acknowledgeParentMailbox).toHaveBeenCalledWith(
      "parent-session",
      ["message-lease"],
    );
  });
});


describe("sub-agent autonomous parent wake", () => {
  it("starts a current idle parent turn through agent-message provenance and acknowledges after completion", async () => {
    const loop = makeConversationLoop("parent-session", []);
    (loop as typeof loop & { hasActiveTurn: ReturnType<typeof vi.fn> }).hasActiveTurn = vi.fn(() => false);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: (parentSessionId: string) => Promise<void>) => {
        wakeHandler = handler;
      }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-1",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    expect(wakeHandler).toBeTypeOf("function");
    await wakeHandler!("parent-session");

    expect(loop.runTurn).toHaveBeenCalledWith(
      "[Sub-Agent: Researcher]\nfinished",
      expect.any(Object),
      undefined,
      expect.objectContaining({
        inputOrigin: "agent-message",
        approvalReasonPrefix: "[Sub-Agent: Researcher]",
      }),
    );
    expect(loop.runTurn.mock.calls[0]?.[3]).not.toHaveProperty("initialGuidance");
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith("parent-session", ["message-1"]);
  });

  it("acknowledges an autonomous mailbox before post-turn bookkeeping fails", async () => {
    const loop = makeConversationLoop("parent-session", [
      { role: "user", content: "existing parent input" },
    ]);
    loop.getSessionProjectIsDefault.mockReturnValue(true);
    (loop as typeof loop & { hasActiveTurn: ReturnType<typeof vi.fn> }).hasActiveTurn =
      vi.fn(() => false);
    loop.runTurn.mockResolvedValue({
      text: "parent response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => {
        wakeHandler = handler;
      }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-wake-bookkeeping-failure",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox,
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    deps.memoryManager.markMainActiveResume.mockRejectedValueOnce(
      new Error("wake-bookkeeping-failed"),
    );

    await expect(wakeHandler!("parent-session")).rejects.toThrow(
      "wake-bookkeeping-failed",
    );

    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith(
      "parent-session",
      ["message-wake-bookkeeping-failure"],
    );
    expect(deps.memoryManager.markMainActiveResume).toHaveBeenCalledWith("parent-session");
    expect(acknowledgeParentMailbox.mock.invocationCallOrder[0])
      .toBeLessThan(deps.memoryManager.markMainActiveResume.mock.invocationCallOrder[0]!);
  });
  it("single-flights autonomous wake before mailbox peek starts", async () => {
    const loop = makeConversationLoop("parent-session", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    let finishTurn!: (result: any) => void;
    loop.runTurn.mockReturnValue(new Promise((resolve) => { finishTurn = resolve; }));
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const peekGate = new SessionMutationGate<Array<{ id: string; formattedText: string; approvalLabel: string }>>();
    const peekEntered = new SessionMutationGate<void>();
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn(() => {
        peekEntered.resolve(undefined);
        return peekGate.promise;
      }),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    const wakePromise = wakeHandler!("parent-session");

    // trackStreamTurn publishes the lease synchronously, before its deferred
    // factory begins mailbox I/O.
    await expect(invoke("lvis:chat:send", {
      input: "concurrent user message",
      inputOrigin: "user-keyboard",
      userActivation: true,
    })).resolves.toEqual({ error: "streaming-active" });
    await expect(invoke("lvis:chat:new")).resolves.toEqual({
      ok: false,
      error: "streaming-active",
    });

    await peekEntered.promise;
    expect(loop.runTurn).not.toHaveBeenCalled();
    peekGate.resolve([{
      id: "message-1",
      formattedText: "[Sub-Agent: Researcher]\nfinished",
      approvalLabel: "[Sub-Agent: Researcher]",
    }]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(loop.runTurn).toHaveBeenCalledTimes(1);

    finishTurn({ text: "done", toolCalls: [], route: "default", stopReason: "end_turn" });
    await wakePromise;
    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
  });
  it("does not start or acknowledge when the requested parent is not current", async () => {
    const loop = makeConversationLoop("current-parent", []);
    (loop as typeof loop & { hasActiveTurn: ReturnType<typeof vi.fn> }).hasActiveTurn = vi.fn(() => false);
    const acknowledgeParentMailbox = vi.fn(async () => 0);
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const runner = {
      setParentWakeHandler: vi.fn((handler: (parentSessionId: string) => Promise<void>) => {
        wakeHandler = handler;
      }),
      peekParentMailbox: vi.fn(async () => []),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    await wakeHandler!("other-parent");

    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(runner.peekParentMailbox).not.toHaveBeenCalled();
    expect(acknowledgeParentMailbox).not.toHaveBeenCalled();
  });
  it("waits for the current stream lease once, then wakes a late mailbox delivery", async () => {
    const loop = makeConversationLoop("parent-session", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    const manualTurn = new SessionMutationGate<any>();
    const manualEntered = new SessionMutationGate<void>();
    loop.runTurn
      .mockImplementationOnce(() => {
        manualEntered.resolve(undefined);
        return manualTurn.promise;
      })
      .mockResolvedValue({
        text: "wake response",
        toolCalls: [],
        route: "default",
        stopReason: "end_turn",
      });

    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const acknowledgeParentMailbox = vi.fn(async () => 1);
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: "message-late",
          formattedText: "[Sub-Agent: Researcher]\nlate result",
          approvalLabel: "[Sub-Agent: Researcher]",
        }]),
      acknowledgeParentMailbox,
    };
    await setupHandlers(loop, { getSubAgentRunner: () => runner });

    const sendPromise = invoke("lvis:chat:send", {
      input: "manual parent turn",
      inputOrigin: "user-keyboard",
      userActivation: true,
    }) as Promise<unknown>;
    await manualEntered.promise;

    const wakePromise = wakeHandler!("parent-session");
    await Promise.resolve();
    expect(runner.peekParentMailbox).toHaveBeenCalledTimes(1);
    expect(loop.runTurn).toHaveBeenCalledTimes(1);

    manualTurn.resolve({
      text: "manual response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    await sendPromise;
    await wakePromise;

    expect(runner.peekParentMailbox).toHaveBeenCalledTimes(2);
    expect(loop.runTurn).toHaveBeenCalledTimes(2);
    expect(loop.runTurn.mock.calls[1]?.[3]).toEqual(
      expect.objectContaining({ inputOrigin: "agent-message" }),
    );
    expect(acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
    expect(acknowledgeParentMailbox).toHaveBeenCalledWith(
      "parent-session",
      ["message-late"],
    );
  });

  it("waits for one same-session mutation lease and then wakes exactly once", async () => {
    const loop = makeConversationLoop("parent-session", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    loop.runTurn.mockResolvedValue({
      text: "wake response",
      toolCalls: [],
      route: "default",
      stopReason: "end_turn",
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-after-mutation",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox: vi.fn(async () => 1),
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    const mutationGate = new SessionMutationGate<void>();
    const mutationEntered = new SessionMutationGate<void>();
    deps.memoryManager.markMainActiveFresh.mockImplementation(() => {
      mutationEntered.resolve(undefined);
      return mutationGate.promise;
    });

    const mutationPromise = invoke("lvis:chat:new") as Promise<unknown>;
    await mutationEntered.promise;
    const wakePromise = wakeHandler!("parent-session");
    await Promise.resolve();
    expect(runner.peekParentMailbox).not.toHaveBeenCalled();

    mutationGate.resolve(undefined);
    await mutationPromise;
    await wakePromise;

    expect(runner.peekParentMailbox).toHaveBeenCalledTimes(1);
    expect(loop.runTurn).toHaveBeenCalledTimes(1);
    expect(runner.acknowledgeParentMailbox).toHaveBeenCalledTimes(1);
  });

  it("does not wake after the captured mutation switches sessions", async () => {
    const loop = makeConversationLoop("parent-session", []);
    (loop as any).hasActiveTurn = vi.fn(() => false);
    loop.newConversation.mockImplementation(() => {
      loop.getSessionId.mockReturnValue("other-session");
    });
    let wakeHandler: ((parentSessionId: string) => Promise<void>) | undefined;
    const runner = {
      setParentWakeHandler: vi.fn((handler: typeof wakeHandler) => { wakeHandler = handler; }),
      peekParentMailbox: vi.fn(async () => [{
        id: "message-stays-durable",
        formattedText: "[Sub-Agent: Researcher]\nfinished",
        approvalLabel: "[Sub-Agent: Researcher]",
      }]),
      acknowledgeParentMailbox: vi.fn(async () => 1),
    };
    const deps = await setupHandlers(loop, { getSubAgentRunner: () => runner });
    const mutationGate = new SessionMutationGate<void>();
    const mutationEntered = new SessionMutationGate<void>();
    deps.memoryManager.markMainActiveFresh.mockImplementation(() => {
      mutationEntered.resolve(undefined);
      return mutationGate.promise;
    });

    const mutationPromise = invoke("lvis:chat:new") as Promise<unknown>;
    await mutationEntered.promise;
    const wakePromise = wakeHandler!("parent-session");
    mutationGate.resolve(undefined);
    await mutationPromise;
    await wakePromise;
    await Promise.resolve();

    expect(runner.peekParentMailbox).not.toHaveBeenCalled();
    expect(loop.runTurn).not.toHaveBeenCalled();
    expect(runner.acknowledgeParentMailbox).not.toHaveBeenCalled();
  });

});
