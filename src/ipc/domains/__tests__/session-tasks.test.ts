/**
 * Session-tasks IPC boundary — the conversation is named, never resolved.
 *
 * The window can hold several conversations at once, so an unnamed call has no
 * answer. These cover the rejection and the fact that no loop is consulted for
 * one, which is what keeps a clear from emptying a tile the caller never meant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CHANNELS } from "../../../contract/app-contract.js";
import { invokeFileIpcHandler } from "./test-helpers.js";

/**
 * A session id the host would have issued. `isValidSessionId`
 * (memory/memory-manager.ts) admits a UUID core and nothing else, so a fixture
 * conversation cannot be named in prose — the channel would refuse a free-form
 * id at `namedSession` before the store under test is ever consulted. The id is
 * derived from the readable name so an assertion still says which conversation
 * it means, and it is the same on every run.
 */
function sessionUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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
