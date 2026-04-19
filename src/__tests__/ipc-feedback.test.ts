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

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    auditLogger: { log: auditLog, search: vi.fn(), getStats: vi.fn() },
    starredStore: { list: starredList, add: starredAdd, remove: vi.fn(), removeBySessionAndIndex: vi.fn(), listBySession: vi.fn() },
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
    memoryManager: { listNotes: vi.fn(() => []), saveNote: vi.fn(), deleteNote: vi.fn(), searchNotes: vi.fn(() => []), getLvisMd: vi.fn(() => ""), updateLvisMd: vi.fn(), getUserPreferences: vi.fn(() => ""), updateUserPreferences: vi.fn(), appendBriefingFeedback: vi.fn(), saveSession: vi.fn() },
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
    registerIpcHandlers(makeServices() as never, () => null);
  });

  it("rejects unauthorized frame", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(ev("https://evil.example.com"), { sessionId: "s1", messageIndex: 0, rating: "up" });
    expect(result).toMatchObject({ ok: false, error: "unauthorized-frame" });
    expect(auditLog).not.toHaveBeenCalledWith(expect.objectContaining({ type: "info" }));
  });

  it("writes audit entry with correct format for thumbs-up", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(null, { sessionId: "sess-42", messageIndex: 3, rating: "up" });
    expect(result).toEqual({ ok: true });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "info",
      sessionId: "sess-42",
      input: "feedback:up:sess-42:3",
    }));
  });

  it("writes audit entry with reason for thumbs-down", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const result = await handler(null, { sessionId: "sess-42", messageIndex: 5, rating: "down", reason: "not helpful" });
    expect(result).toEqual({ ok: true });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "info",
      sessionId: "sess-42",
      input: "feedback:down:sess-42:5:not helpful",
    }));
  });

  it("truncates reason at 200 chars", async () => {
    const handler = handlers.get("lvis:feedback:submit")!;
    const longReason = "x".repeat(300);
    await handler(null, { sessionId: "s", messageIndex: 0, rating: "down", reason: longReason });
    const logged = auditLog.mock.calls.find((c: unknown[]) => (c[0] as { type: string }).type === "info");
    const input: string = logged?.[0].input;
    expect(input).toContain("x".repeat(200));
    expect(input.length).toBeLessThan("x".repeat(300).length + 50);
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
    const result = await handler(null, { sessionId: "s", messageIndex: -1, rating: "invalid" });
    expect(result).toMatchObject({ ok: false, error: "invalid-args" });
  });
});
