/**
 * Session-todo IPC boundary — the conversation is named, never resolved.
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
      { id: "1", title: `todo for ${sessionId}`, status: "pending" },
    ]),
    clear: vi.fn(),
    onChange: vi.fn(),
  };
  const getSessionId = vi.fn(() => PRIMARY_SESSION);
  const { registerSessionTodoHandlers } = await import("../session-todo.js");
  registerSessionTodoHandlers({
    sessionTodoStore: store,
    conversationLoop: { getSessionId },
    auditLogger: { log: vi.fn() },
    getMainWindow: () => null,
  } as never);
  return { store, getSessionId };
}

beforeEach(() => {
  handlers.clear();
});

describe("session-todo IPC", () => {
  it("lists the named session's todos", async () => {
    const { store } = await setup();

    await expect(
      invokeFileIpcHandler(handlers, CHANNELS.sessionTodo.list, "tile-2-session"),
    ).resolves.toEqual([{ id: "1", title: "todo for tile-2-session", status: "pending" }]);
    expect(store.list).toHaveBeenCalledWith("tile-2-session");
  });

  it("clears the named session's todos", async () => {
    const { store } = await setup();

    await expect(
      invokeFileIpcHandler(handlers, CHANNELS.sessionTodo.clear, "tile-2-session"),
    ).resolves.toEqual({ ok: true });
    expect(store.clear).toHaveBeenCalledWith("tile-2-session");
  });

  it.each([
    ["list", CHANNELS.sessionTodo.list],
    ["clear", CHANNELS.sessionTodo.clear],
  ])("%s rejects a call that names no session instead of resolving one", async (_name, channel) => {
    const { store, getSessionId } = await setup();

    // `ipcMain.handle` turns a thrown handler into a rejected renderer promise;
    // the helper calls the handler directly, so the throw is seen here.
    expect(() => invokeFileIpcHandler(handlers, channel)).toThrow("session-id-required");
    expect(() => invokeFileIpcHandler(handlers, channel, "   ")).toThrow("session-id-required");

    expect(getSessionId).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });
});
