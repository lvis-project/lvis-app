/**
 * Session-goal IPC boundary — the conversation is named, never resolved, and
 * the chip's three answers reach the store unchanged.
 *
 * Same rule as the session-tasks domain: the window can hold several
 * conversations, so an unnamed call has no answer. Pausing "the current
 * session" would stop a goal in a tile the caller never meant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const store = {
    get: vi.fn((sessionId: string) => ({
      text: `goal for ${sessionId}`,
      status: "running",
      round: 3,
      ceiling: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    onChange: vi.fn(),
  };
  const { registerSessionGoalHandlers } = await import("../session-goal.js");
  registerSessionGoalHandlers({
    sessionGoalStore: store,
    auditLogger: { log: vi.fn() },
    getMainWindow: () => null,
  } as never);
  return { store };
}

beforeEach(() => {
  handlers.clear();
});

// Real session ids: the handlers validate the argument against the one session-id
// SOT (`isValidSessionId`), which takes a UUID with an optional namespace prefix.
// A readable stand-in like "tile-2" is rejected there, so the test would prove
// the rejection rather than the routing it is about.
const SESSION_A = "3f0c1a92-6d41-4b7e-9a05-2c8ef1b4d730";
const SESSION_B = "b71e4d38-0c25-4af6-8e19-5d63a90c7f42";

describe("session-goal IPC", () => {
  it("reads the named session's goal", async () => {
    const { store } = await setup();
    await expect(
      invokeFileIpcHandler(handlers, CHANNELS.sessionGoal.get, SESSION_B),
    ).resolves.toMatchObject({ text: `goal for ${SESSION_B}`, round: 3 });
    expect(store.get).toHaveBeenCalledWith(SESSION_B);
  });

  it("routes stop, resume and dismiss to the named session", async () => {
    const { store } = await setup();
    await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionGoal.pause, SESSION_A))
      .resolves.toEqual({ ok: true });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionGoal.resume, SESSION_A))
      .resolves.toEqual({ ok: true });
    await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionGoal.clear, SESSION_A))
      .resolves.toEqual({ ok: true });
    expect(store.pause).toHaveBeenCalledWith(SESSION_A);
    expect(store.resume).toHaveBeenCalledWith(SESSION_A);
    expect(store.clear).toHaveBeenCalledWith(SESSION_A);
  });

  it("refuses a call that names no session, without touching the store", async () => {
    const { store } = await setup();
    for (const argument of [undefined, "", "   ", 42, "../escape"]) {
      await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionGoal.get, argument))
        .resolves.toBeNull();
      await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionGoal.pause, argument))
        .resolves.toEqual({ ok: false, error: "session-id-required" });
    }
    expect(store.get).not.toHaveBeenCalled();
    expect(store.pause).not.toHaveBeenCalled();
  });

  it("reports a session with no goal rather than throwing at the renderer", async () => {
    handlers.clear();
    vi.clearAllMocks();
    const { SessionGoalMissingError } = await import("../../../main/session-goal-store.js");
    const { registerSessionGoalHandlers } = await import("../session-goal.js");
    registerSessionGoalHandlers({
      sessionGoalStore: {
        get: () => null,
        pause: async () => { throw new SessionGoalMissingError(); },
        resume: async () => {},
        clear: async () => {},
        onChange: vi.fn(),
      },
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
    } as never);
    await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionGoal.pause, SESSION_A))
      .resolves.toEqual({ ok: false, error: "no-session-goal" });
  });
});
