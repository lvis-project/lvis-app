/**
 * IPC Bridge — lvis:plugin:ask-home-chat handler tests (PR #297).
 *
 * Strategy: register handlers via registerIpcHandlers with mocked services,
 * then invoke the handler directly with synthetic IpcMainInvokeEvent objects.
 *
 * The lvis:plugin:ask-home-chat handler uses resolvePluginFromSender which
 * calls validatePluginFrame + pluginWebviewRegistry. To test the authorized
 * path we:
 *   1. mock devLinkedEntryAllowed → true (skips realpathSync containment check)
 *   2. mock node:fs realpathSync → identity (no real FS access)
 *   3. invoke lvis:plugin:register-webview with a trusted null-event to pre-
 *      populate pluginWebviewRegistry for sender.id = 99
 *   4. send plugin-frame events with sender.id = 99 and a plugin-ui-shell URL
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeLlmSettings } from "../shared/__tests__/fake-llm-settings.js";

// ─── Mock node:fs (realpathSync used by register-webview) ─────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: vi.fn((p: unknown) => p),
  };
});

// ─── Mock dev-flags: devLinkedEntryAllowed → true ─────────────────────────────

vi.mock("../boot/dev-flags.js", () => ({
  devLinkedEntryAllowed: vi.fn(() => true),
  isDevModeUnlocked: vi.fn(() => false),
}));

// ─── Mock electron ────────────────────────────────────────────────────────────

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const mockWebContentsSend = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// ─── Mock policy-store ────────────────────────────────────────────────────────

vi.mock("../permissions/policy-store.js", () => ({
  loadPolicy: vi.fn(),
  savePolicy: vi.fn(),
}));

// ─── Build AppServices stub ───────────────────────────────────────────────────

function makeMockPM() {
  return {
    getMode: vi.fn(() => "default"),
    setModePersist: vi.fn(),
    listPersistedRules: vi.fn(async () => []),
    addAlwaysAllowedPersist: vi.fn(),
    addAlwaysDeniedPersist: vi.fn(),
    removeRule: vi.fn(),
    getVisibilityDenyRules: vi.fn(() => []),
  };
}

function makeMockLoop(pm: ReturnType<typeof makeMockPM>) {
  return {
    permissionManager: pm,
    hasProvider: vi.fn(),
    runTurn: vi.fn(),
    newConversation: vi.fn(),
    getSessionId: vi.fn(() => "s1"),
    listSessions: vi.fn(() => []),
    loadSession: vi.fn(),
    refreshProvider: vi.fn(),
  };
}

function makeMockGate() {
  return { resolve: vi.fn(), setPolicy: vi.fn() };
}

function makeServices(pm = makeMockPM(), gate = makeMockGate()) {
  const mockAuditLogger = { log: vi.fn() };
  return {
    pluginRuntime: {
      call: vi.fn(),
      listToolNames: vi.fn(() => []),
      listPluginIds: vi.fn(() => ["com.lge.meeting-recorder"]),
      listPluginCards: vi.fn(() => []),
      restartAll: vi.fn(),
      setConfigOverride: vi.fn(),
      listUiExtensions: vi.fn(() => []),
      getPluginManifest: vi.fn((id: string) =>
        id === "com.lge.meeting-recorder"
          ? { tools: ["meeting_start"], capabilities: [] }
          : null,
      ),
      getPluginRoot: vi.fn((_id: string) => "/fake/plugins/meeting"),
    } as any,
    pluginMarketplace: { list: vi.fn(), install: vi.fn(), uninstall: vi.fn() } as any,
    taskService: {
      add: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      query: vi.fn(),
      getPendingByPriority: vi.fn(() => []),
      getOverdue: vi.fn(() => []),
      getDueToday: vi.fn(() => []),
    } as any,
    settingsService: {
      getAll: vi.fn(),
      patch: vi.fn(),
      get: vi.fn(() => fakeLlmSettings()),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async (_pluginId: string, config: unknown) => config),
    } as any,
    memoryManager: {
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      getMemoryContext: vi.fn(() => ""),
      getLvisMd: vi.fn(),
      updateLvisMd: vi.fn(),
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
    } as any,
    conversationLoop: makeMockLoop(pm) as any,
    approvalGate: gate as any,
    mcpManager: { listServers: vi.fn(() => []), killSwitch: vi.fn() } as any,
    toolRegistry: { setDenyRules: vi.fn(), size: 0 } as any,
    auditLogger: mockAuditLogger as any,
    idleScheduler: undefined,
    bashAstValidator: {} as any,
    auditService: {} as any,
    postTurnHookChain: {} as any,
    knowledgeAvailable: false,
  };
}

// ─── getMainWindow stub — returns a window with a spy on webContents.send ─────

function makeMainWindowGetter() {
  mockWebContentsSend.mockReset();
  return () => ({
    isDestroyed: () => false,
    webContents: { send: mockWebContentsSend },
  });
}

// ─── Invocation helpers ───────────────────────────────────────────────────────

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

/** A fake IpcMainInvokeEvent from a plugin-ui-shell frame with sender.id = 99. */
function pluginEvent() {
  return {
    senderFrame: { url: "file:///dist/src/plugin-ui-shell.html" },
    sender: { id: 99 },
  };
}

/** A fake IpcMainInvokeEvent from an untrusted (non-plugin) frame. */
function untrustedEvent() {
  return {
    senderFrame: { url: "https://evil.example.com/" },
    sender: { id: 1 },
  };
}

// ─── Setup helpers ────────────────────────────────────────────────────────────

async function setupHandlers() {
  handlers.clear();
  vi.clearAllMocks();
  const { registerIpcHandlers } = await import("../ipc-bridge.js");
  registerIpcHandlers(makeServices(), makeMainWindowGetter() as any);
  // Pre-register webview binding for sender.id = 99 (the "authorized" plugin frame).
  // validateSender(null) → true (unit-test ergonomics), devLinkedEntryAllowed → true,
  // realpathSync → identity. This populates pluginWebviewRegistry[99].
  await invoke("lvis:plugin:register-webview", {
    webContentsId: 99,
    pluginId: "com.lge.meeting-recorder",
    entryUrl: "file:///fake/plugins/meeting/dist/ui/index.js",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("lvis:plugin:ask-home-chat", () => {
  beforeEach(async () => {
    await setupHandlers();
  });

  it("unauthorized sender → UNAUTHORIZED_FRAME + auditUnauthorized called", async () => {
    const result = await invokeWithEvent(
      "lvis:plugin:ask-home-chat",
      untrustedEvent(),
      "hello",
    );
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("text is not a string → { ok: false, error: 'invalid-text' }", async () => {
    const result = await invokeWithEvent(
      "lvis:plugin:ask-home-chat",
      pluginEvent(),
      42,
    );
    expect(result).toEqual({ ok: false, error: "invalid-text" });
  });

  it("whitespace-only string → { ok: false, error: 'empty-text' }", async () => {
    const result = await invokeWithEvent(
      "lvis:plugin:ask-home-chat",
      pluginEvent(),
      "   ",
    );
    expect(result).toEqual({ ok: false, error: "empty-text" });
  });

  it("string > 4000 chars → { ok: false, error: 'text-too-long' }", async () => {
    const longText = "x".repeat(4001);
    const result = await invokeWithEvent(
      "lvis:plugin:ask-home-chat",
      pluginEvent(),
      longText,
    );
    expect(result).toEqual({ ok: false, error: "text-too-long" });
  });

  it("valid text → webContents.send called with lvis:host:plugin-ask + { pluginId, text }, returns { ok: true }", async () => {
    const result = await invokeWithEvent(
      "lvis:plugin:ask-home-chat",
      pluginEvent(),
      "  hello world  ",
    );
    expect(result).toEqual({ ok: true });
    expect(mockWebContentsSend).toHaveBeenCalledWith("lvis:host:plugin-ask", {
      pluginId: "com.lge.meeting-recorder",
      text: "hello world",
    });
  });
});
