/**
 * Issue #749 — lvis:chat:get-write-diff IPC handler unit tests.
 *
 * Strategy: register chat IPC handlers with a minimal mock conversationLoop
 * and a fake readDiffSidecar, then invoke the handler directly to cover:
 *   - valid (sessionId, toolUseId) → { before, after }
 *   - invalid sessionId (not matching active) → null
 *   - unknown / unsafe toolUseId → null
 *   - unsafe ids (path traversal) → null
 *   - sidecar not found → null
 *   - unauthorized sender → null
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock electron ─────────────────────────────────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// ─── Mock write-diff-cache (readDiffSidecar) ─────────────────────────────────
const mockReadDiffSidecar = vi.fn<
  (sessionId: string, toolUseId: string) => Promise<{ before: string; after: string } | null>
>();

vi.mock("../../../tools/write-diff-cache.js", () => ({
  readDiffSidecar: mockReadDiffSidecar,
  isSafeId: (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id),
  WRITE_DIFF_PREVIEW_LIMIT: 4096,
  writeDiffSidecar: vi.fn(),
  clearSessionDiffCache: vi.fn(),
  purgeStaleSessionDiffDirs: vi.fn(),
}));

// ─── Minimal mocks for chat domain deps ──────────────────────────────────────
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
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));
vi.mock("../../../shared/chat-history.js", () => ({
  serializeHistoryMessage: vi.fn((m: unknown, i: number) => ({ ...m as object, index: i })),
}));
vi.mock("../../../shared/fake-llm-settings.js", () => ({ fakeLlmSettings: {} }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SESSION_ID = "session-abc";
const TOOL_USE_ID = "tu-def456";

function makeConversationLoop(sessionId: string) {
  return {
    getSessionId: vi.fn(() => sessionId),
    getHistory: vi.fn(() => ({
      getMessages: vi.fn(() => []),
      truncate: vi.fn(),
    })),
    hasProvider: vi.fn(() => true),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
    abortCurrentTurn: vi.fn(),
    pingProvider: vi.fn(async () => ({
      configured: true,
      online: true,
      vendor: "openai",
      model: "gpt-4o",
      latencyMs: 1,
    })),
    resetAndResume: vi.fn(),
    manualCompact: vi.fn(),
    startRoutineConversation: vi.fn(),
    enterViewMode: vi.fn(),
    exitViewMode: vi.fn(),
    branchFromCheckpoint: vi.fn(),
    queueGuidance: vi.fn(),
    generateText: vi.fn(),
  };
}

function makeMinimalDeps(loop: ReturnType<typeof makeConversationLoop>) {
  return {
    conversationLoop: loop,
    settingsService: {
      get: vi.fn(() => ({ llm: { provider: "claude", vendors: { claude: {} } }, telemetry: {}, updates: {}, marketplace: {} })),
      patch: vi.fn(),
      getSecret: vi.fn(() => null),
    },
    memoryManager: {
      saveSession: vi.fn(),
      loadSession: vi.fn(() => null),
      listSessionEntries: vi.fn(() => []),
      searchSessions: vi.fn(() => []),
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      getMemoryIndex: vi.fn(() => ""),
      updateMemoryIndexIfUnchanged: vi.fn(() => true),
      updateMemoryIndexSections: vi.fn(),
      getAgentsMd: vi.fn(() => ""),
      updateAgentsMd: vi.fn(),
      getUserPreferences: vi.fn(() => ""),
      updateUserPreferences: vi.fn(),
      loadSessionMetadata: vi.fn(() => null),
    },
    starredStore: null,
    feedbackStore: null,
    auditLogger: { log: vi.fn() },
    askUserQuestionGate: null,
    preferenceRefreshService: null,
    getMainWindow: vi.fn(() => null),
  };
}

const CHANNEL = "lvis:chat:get-write-diff";

async function setupHandlers(loop: ReturnType<typeof makeConversationLoop>) {
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

function invokeWithEvent(channel: string, event: unknown, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(event, ...args);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("lvis:chat:get-write-diff", () => {
  beforeEach(() => {
    mockReadDiffSidecar.mockReset();
  });

  it("returns { before, after } when sidecar exists and sessionId matches", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);
    mockReadDiffSidecar.mockResolvedValue({ before: "old content", after: "new content" });

    const result = await invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: TOOL_USE_ID });
    expect(result).toEqual({ before: "old content", after: "new content" });
    expect(mockReadDiffSidecar).toHaveBeenCalledWith(SESSION_ID, TOOL_USE_ID);
  });

  it("returns null when sidecar is not found (readDiffSidecar returns null)", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);
    mockReadDiffSidecar.mockResolvedValue(null);

    const result = await invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: TOOL_USE_ID });
    expect(result).toBeNull();
  });

  it("returns null for unsafe sessionId (path traversal)", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invoke(CHANNEL, { sessionId: "../../etc/passwd", toolUseId: TOOL_USE_ID });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for unsafe toolUseId", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invoke(CHANNEL, { sessionId: SESSION_ID, toolUseId: "../evil" });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for empty sessionId", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invoke(CHANNEL, { sessionId: "", toolUseId: TOOL_USE_ID });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for non-string payload fields", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invoke(CHANNEL, { sessionId: 123, toolUseId: null });
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });

  it("returns null for null payload", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invoke(CHANNEL, null);
    expect(result).toBeNull();
    expect(mockReadDiffSidecar).not.toHaveBeenCalled();
  });
});

describe("lvis:llm:ping", () => {
  it("rejects an untrusted sender frame and does not ping the provider", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invokeWithEvent(
      "lvis:llm:ping",
      { senderFrame: { url: "https://evil.example/app" } },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(loop.pingProvider).not.toHaveBeenCalled();
  });

  it("delegates trusted renderer requests to ConversationLoop.pingProvider", async () => {
    const loop = makeConversationLoop(SESSION_ID);
    await setupHandlers(loop);

    const result = await invoke("lvis:llm:ping");
    expect(result).toMatchObject({ configured: true, online: true });
    expect(loop.pingProvider).toHaveBeenCalledOnce();
  });
});
