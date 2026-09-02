/**
 * Session-tasks IPC boundary — the conversation is named, never resolved.
 *
 * The window can hold several conversations at once, so an unnamed call has no
 * answer. These cover the rejection and the fact that no loop is consulted for
 * one, which is what keeps a clear from emptying a tile the caller never meant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionUuid } from "../../../__tests__/support/session-uuid.js";
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

const PRIMARY_SESSION = sessionUuid("primary-session");
const TILE_SESSION = sessionUuid("tile-2-session");

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  const store = {
    list: vi.fn((sessionId: string) => [
      { id: "1", content: `task for ${sessionId}`, status: "pending" },
    ]),
    clear: vi.fn(async () => {}),
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
      invokeFileIpcHandler(handlers, CHANNELS.sessionTasks.list, TILE_SESSION),
    ).resolves.toEqual([{ id: "1", content: `task for ${TILE_SESSION}`, status: "pending" }]);
    expect(store.list).toHaveBeenCalledWith(TILE_SESSION);
  });

  it("clears the named session's tasks", async () => {
    const { store } = await setup();

    await expect(
      invokeFileIpcHandler(handlers, CHANNELS.sessionTasks.clear, TILE_SESSION),
    ).resolves.toEqual({ ok: true });
    expect(store.clear).toHaveBeenCalledWith(TILE_SESSION);
  });

  // A refusal in the channel's own shape, not a throw: the panel's read is
  // fire-and-forget, so a rejected promise would surface as an unhandled
  // rejection rather than as an answer.
  it.each([
    ["nothing at all", undefined],
    ["whitespace", "   "],
    ["a malformed id", "../not-a-session"],
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
    ["a malformed id", "../not-a-session"],
  ])("refuses a clear that names no session (%s) instead of resolving one", async (_name, argument) => {
    const { store, getSessionId } = await setup();

    await expect(invokeFileIpcHandler(handlers, CHANNELS.sessionTasks.clear, argument))
      .resolves.toEqual({ ok: false, error: "session-id-required" });
    expect(getSessionId).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });
});
