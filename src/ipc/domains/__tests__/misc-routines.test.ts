import { describe, it, expect, vi, beforeEach } from "vitest";
import { ROUTINES_V2 } from "../../../shared/ipc-channels.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock("../../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })),
}));

function makeDeps(
  sessions: Array<{ id: string; routineFiredAt?: string; title?: string; preview: string }>,
  lastRoutineSessionId?: string,
) {
  return {
    routinesStore: {
      list: vi.fn(() => [
        {
          id: "routine-a",
          trigger: "schedule",
          execution: "llm-session",
          title: "Routine A",
          lastFiredAt: "2026-05-16T12:00:00.000Z",
          lastResultAcknowledgedAt: "2026-05-15T12:00:00.000Z",
          ...(lastRoutineSessionId ? { lastRoutineSessionId } : {}),
        },
      ]),
      listActive: vi.fn(() => []),
      update: vi.fn(),
      dismiss: vi.fn(),
      remove: vi.fn(),
      add: vi.fn(),
    },
    routinesScheduler: null,
    sessionTodoStore: null,
    conversationLoop: { getSessionId: vi.fn(() => "main-session") },
    memoryManager: {
      listSessionsByRoutine: vi.fn(() => sessions),
      deleteSession: vi.fn(),
    },
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => null),
  };
}

async function setup(
  sessions: Array<{ id: string; routineFiredAt?: string; title?: string; preview: string }>,
  lastRoutineSessionId?: string,
) {
  handlers.clear();
  const { registerMiscHandlers } = await import("../misc.js");
  const deps = makeDeps(sessions, lastRoutineSessionId);
  registerMiscHandlers(deps as any);
  return deps;
}

async function invoke(channel: string, ...args: unknown[]) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return await fn(null, ...args);
}

describe("routine pending results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches only the stored exact routine session id", async () => {
    await setup([
      { id: "latest-wrong", routineFiredAt: "2026-05-16T13:00:00.000Z", preview: "wrong preview" },
      { id: "exact-session", routineFiredAt: "2026-05-16T12:00:00.000Z", preview: "exact preview" },
    ], "exact-session");

    const results = await invoke(ROUTINES_V2.pendingResults);

    expect(results).toEqual([
      expect.objectContaining({
        id: "routine-a",
        routineSessionId: "exact-session",
        summary: "exact preview",
      }),
    ]);
  });

  it("does not fall back to the latest routine session when the stored id is missing", async () => {
    await setup([
      { id: "latest-wrong", routineFiredAt: "2026-05-16T13:00:00.000Z", preview: "wrong preview" },
    ]);

    const results = await invoke(ROUTINES_V2.pendingResults);

    expect(results).toEqual([
      expect.not.objectContaining({
        routineSessionId: "latest-wrong",
      }),
    ]);
    expect(results[0]).not.toHaveProperty("routineSessionId");
    expect(results[0]).toHaveProperty("summary", "");
  });

  it("does not fall back to a firedAt match when the stored id points elsewhere", async () => {
    await setup([
      { id: "fired-at-match", routineFiredAt: "2026-05-16T12:00:00.000Z", preview: "fired-at preview" },
    ], "missing-session");

    const results = await invoke(ROUTINES_V2.pendingResults);

    expect(results[0]).not.toHaveProperty("routineSessionId");
    expect(results[0]).toHaveProperty("summary", "");
  });

  it("returns routine session previews for the routine history list", async () => {
    await setup([
      {
        id: "routine-session-1",
        routineFiredAt: "2026-05-16T12:00:00.000Z",
        title: "뉴스 요약",
        preview: "뉴스 요약 완료",
      },
    ]);

    const results = await invoke(ROUTINES_V2.listSessions, "routine-a", 10);

    expect(results).toEqual([
      {
        routineId: "routine-a",
        firedAt: "2026-05-16T12:00:00.000Z",
        sessionId: "routine-session-1",
        title: "뉴스 요약",
        preview: "뉴스 요약 완료",
      },
    ]);
  });
});
