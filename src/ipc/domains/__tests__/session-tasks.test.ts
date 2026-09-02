/**
 * Session-tasks IPC boundary — the conversation is named, never resolved.
 *
 * The window can hold several conversations at once, so an unnamed call has no
 * answer. These cover the rejection and the fact that no loop is consulted for
 * one, which is what keeps a clear from emptying a tile the caller never meant.
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

const PRIMARY_SESSION = "primary-session";

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const store = {
    list: vi.fn((sessionId: string) => [
      { id: "1", title: `task for ${sessionId}`, status: "pending" },
    ]),
    clear: vi.fn(),
    onChange: vi.fn(),
  };
  const getSessionId = vi.fn(() => PRIMARY_SESSION);
  const { registerSessionTasksHandlers } = await import("../session-tasks.js");
  registerSessionTasksHandlers({
    sessionTasksStore: store,
    conversationLoop: { getSessionId },
    auditLogger: { log: vi.fn() },
    getMainWindow: () => null,
  } as never);
  return { store, getSessionId };
}

beforeEach(() => {
  handlers.clear();
});

describe("session-tasks IPC", () => {
  it("lists the named session's tasks", async () => {
    const { store } = await setup();

    await expect(
      invokeFileIpcHandler(handlers, CHANNELS.sessionTasks.list, "tile-2-session"),
    ).resolves.toEqual([{ id: "1", title: "task for tile-2-session", status: "pending" }]);
    expect(store.list).toHaveBeenCalledWith("tile-2-session");
  });

  it("clears the named session's tasks", async () => {
    const { store } = await setup();

    await expect(
      invokeFileIpcHandler(handlers, CHANNELS.sessionTasks.clear, "tile-2-session"),
    ).resolves.toEqual({ ok: true });
    expect(store.clear).toHaveBeenCalledWith("tile-2-session");
  });

  // A refusal in the channel's own shape, not a throw: the panel's read is
  // fire-and-forget, so a rejected promise would surface as an unhandled
  // rejection rather than as an answer.
  it.each([
    ["nothing at all", undefined],
    ["whitespace", "   "],
  ])("refuses a list that names no session (%s) instead of resolving one", async (_name, argument) => {
    const { store, getSessionId } = await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionTasks.list, argument))
      .resolves.toEqual([]);
    expect(getSessionId).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });

  it.each([
    ["nothing at all", undefined],
    ["whitespace", "   "],
  ])("refuses a clear that names no session (%s) instead of resolving one", async (_name, argument) => {
    const { store, getSessionId } = await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionTasks.clear, argument))
      .resolves.toEqual({ ok: false, error: "session-id-required" });
    expect(getSessionId).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });
});
