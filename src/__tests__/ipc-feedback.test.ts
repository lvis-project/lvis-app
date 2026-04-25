/**
 * D6 — lvis:feedback:submit IPC handler tests.
 * Covers sender validation + audit write format.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

// Capture registered handlers by channel name.
const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: {},
}));

// Mock AuditLogger
const auditLog = vi.fn();

// Mock StarredStore
const starredList = vi.fn(() => [] as unknown[]);
const starredAdd = vi.fn(() => ({ id: "x", sessionId: "s1", messageIndex: 0, role: "assistant", text: "", starredAt: new Date().toISOString() }));

// Mock FeedbackStore
const feedbackAdd = vi.fn(() => ({ id: "fb1", sessionId: "s1", messageIndex: 0, rating: "down", timestamp: new Date().toISOString() }));

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    auditLogger: { log: auditLog, search: vi.fn(), getStats: vi.fn() },
    starredStore: { list: starredList, add: starredAdd, remove: vi.fn(), removeBySessionAndIndex: vi.fn(), listBySession: vi.fn() },
    feedbackStore: { add: feedbackAdd, list: vi.fn(() => []), prune: vi.fn() },
    settingsService: { getAll: vi.fn(() => ({})), get: vi.fn(() => ({})), patch: vi.fn(), getSecret: vi.fn(() => null), setSecret: vi.fn(), deleteSecret: vi.fn() },
    conversationLoop: {
      getSessionId: vi.fn(() => "sess-test"),
      hasProvider: vi.fn(() => true),
      runTurn: vi.fn(),
      newConversation: vi.fn(),
      listSessions: vi.fn(() => []),
      loadSession: vi.fn(() => true),
      getHistory: vi.fn(() => ({ getMessages: vi.fn(() => []) })),
      refreshProvider: vi.fn(),
      abortCurrentTurn: vi.fn(),
      manualCompact: vi.fn(),
      resetAndResume: vi.fn(),
      permissionManager: null,
      generateBriefing: vi.fn(),
    },
    pluginRuntime: { listUiExtensions: vi.fn(() => []), listPluginCards: vi.fn(() => []), callFromUi: vi.fn(), restartAll: vi.fn(), getPerfStats: vi.fn(() => ({})) },
    pluginMarketplace: { list: vi.fn(() => []), install: vi.fn(), uninstall: vi.fn() },
    taskService: { add: vi.fn(), update: vi.fn(), get: vi.fn(), delete: vi.fn(), query: vi.fn(() => []), getPendingByPriority: vi.fn(() => []), getOverdue: vi.fn(() => []), getDueToday: vi.fn(() => []) },
    memoryManager: { listMemoryEntries: vi.fn(() => []), saveMemory: vi.fn(), deleteMemory: vi.fn(), searchMemoryEntries: vi.fn(() => []), getMemoryContext: vi.fn(() => ""), getLvisMd: vi.fn(() => ""), updateLvisMd: vi.fn(), getUserPreferences: vi.fn(() => ""), updateUserPreferences: vi.fn(), saveSession: vi.fn() },
    msGraphService: {
      getEnvironment: vi.fn(() => "external"),
      getState: vi.fn(() => ({
        environment: "external",
        isAuthenticated: false,
        account: null,
        configured: true,
        label: "External",
      })),
      startInteractiveAuth: vi.fn(async () => undefined),
      signOut: vi.fn(async () => undefined),
      switchEnvironment: vi.fn(async () => undefined),
      getAccountName: vi.fn(() => null),
    },
    approvalGate: null,
    refreshPluginNotifications: vi.fn(),
    mcpManager: { listServers: vi.fn(() => []), killSwitch: vi.fn() },
    ...overrides,
  };
}

function ev(url: string): IpcMainInvokeEvent {
  return { senderFrame: { url } } as unknown as IpcMainInvokeEvent;
}

import { registerIpcHandlers } from "../ipc-bridge.js";

describe("lvis:feedback:submit", () => {
  beforeEach(() => {
    handlers.clear();
    auditLog.mockClear();
    starredList.mockClear();
    starredAdd.mockClear();
    feedbackAdd.mockClear();
    registerIpcHandlers(makeServices() as never, () => null);
  });

  it("rejects unauthorized frame", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(ev("https://evil.example.com"), { sessionId: "s1", messageIndex: 0, rating: "up" });
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(feedbackAdd).not.toHaveBeenCalled();
  });

  it("writes audit entry with correct stripped format for thumbs-up (no reason)", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(null, { sessionId: "sess-42", messageIndex: 3, rating: "up" });
    expect(result).toEqual({ ok: true });
    // Audit log must NOT contain reason text — only stripped aggregate line
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-42",
      input: "feedback:up:sess-42:3",
    }));
    const call = auditLog.mock.calls[0][0] as { input: string };
    expect(call.input).not.toMatch(/:/g.source.slice(0, -1) + "{4,}"); // no extra colon-delimited field
  });

  it("writes feedback with reason to FeedbackStore, NOT audit log input", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(null, { sessionId: "sess-42", messageIndex: 5, rating: "down", reason: "not helpful" });
    expect(result).toEqual({ ok: true });
    // FeedbackStore gets the reason
    expect(feedbackAdd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-42",
      messageIndex: 5,
      rating: "down",
      reason: "not helpful",
    }));
    // Audit log gets stripped line — no reason text
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess-42",
      input: "feedback:down:sess-42:5",
    }));
    const auditInput: string = (auditLog.mock.calls[0][0] as { input: string }).input;
    expect(auditInput).not.toContain("not helpful");
  });

  it("FeedbackStore receives reason without truncation (store owns retention)", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const longReason = "x".repeat(300);
    await handler(null, { sessionId: "s", messageIndex: 0, rating: "down", reason: longReason });
    expect(feedbackAdd).toHaveBeenCalledWith(expect.objectContaining({ reason: longReason }));
    // Audit log still has no reason
    const auditInput: string = (auditLog.mock.calls[0][0] as { input: string }).input;
    expect(auditInput).not.toContain("x");
  });

  it("auto-stars on thumbs-up when not already starred", async () => {
    starredList.mockReturnValue([]);
    const handler = handlers.get("lvis:feedback:submit")!;
    await handler(null, { sessionId: "s1", messageIndex: 2, rating: "up" });
    expect(starredAdd).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", messageIndex: 2 }));
  });

  it("skips auto-star on thumbs-up when already starred", async () => {
    starredList.mockReturnValue([{ id: "x", sessionId: "s1", messageIndex: 2, role: "assistant", text: "", starredAt: "" }]);
    const handler = handlers.get("lvis:feedback:submit")!;
    await handler(null, { sessionId: "s1", messageIndex: 2, rating: "up" });
    expect(starredAdd).not.toHaveBeenCalled();
  });

  it("returns invalid-args for bad payload", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(null, { sessionId: "s", messageIndex: 0, rating: "invalid" });
    expect(result).toMatchObject({ ok: false, error: "invalid-args" });
  });

  it("returns invalid-args for negative messageIndex", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(null, { sessionId: "s", messageIndex: -1, rating: "down" });
    expect(result).toMatchObject({ ok: false, error: "invalid-args" });
  });
});

describe("lvis:ms-graph:sign-in", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it("returns an explicit stale-sign-in error when the environment changed mid-auth", async () => {
    const msGraphService = {
      getEnvironment: vi.fn(() => "external"),
      startInteractiveAuth: vi.fn(async () => undefined),
      getState: vi.fn(() => ({
        environment: "corporate",
        isAuthenticated: false,
        account: null,
        configured: true,
        label: "Corporate",
      })),
      signOut: vi.fn(async () => undefined),
      switchEnvironment: vi.fn(async () => undefined),
      getAccountName: vi.fn(() => null),
    };
    registerIpcHandlers(makeServices({ msGraphService }) as never, () => null);

    const handler = handlers.get("lvis:ms-graph:sign-in")!;
    const result = await handler(null);

    expect(result).toEqual({
      ok: false,
      error: "environment-switched-during-sign-in",
      state: {
        environment: "corporate",
        isAuthenticated: false,
        account: null,
        configured: true,
        label: "Corporate",
      },
    });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "warn",
      output: "ms-graph sign-in failed: env=external error=environment-switched-during-sign-in",
    }));
  });
});
