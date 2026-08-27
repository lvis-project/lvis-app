/**
 * Tiled chat groups at the IPC boundary: every per-conversation channel names
 * its group, each group runs on its own loop, and a closed tile's group is
 * released.
 *
 * The property under test is separation. A registrar that handed every group
 * the primary loop would pass every other chat test — those only ever speak
 * to "main" — while four tiles quietly shared one conversation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../../../contract/app-contract.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const RENDERER_EVENT = { senderFrame: { url: "file:///index.html" } };

vi.mock("../../gated.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateHostRendererSender: () => true,
}));

type FakeLoop = {
  id: string;
  sessionId: string;
  hasProvider: ReturnType<typeof vi.fn>;
  abortCurrentTurn: ReturnType<typeof vi.fn>;
  getSessionId: () => string;
  getSessionKind: () => "main";
  hasActiveTurn: () => boolean;
  getHistory: () => { length: number; getMessages: () => unknown[]; truncate: () => void; restore: () => void };
  refreshProvider: () => void;
};

function fakeLoop(id: string, messages: unknown[] = []): FakeLoop {
  return {
    id,
    sessionId: `session-of-${id}`,
    hasProvider: vi.fn(() => id !== MAIN_CHAT_GROUP_ID),
    abortCurrentTurn: vi.fn(),
    getSessionId: () => `session-of-${id}`,
    getSessionKind: () => "main",
    hasActiveTurn: () => false,
    getHistory: () => ({ length: messages.length, getMessages: () => messages, truncate: () => {}, restore: () => {} }),
    refreshProvider: () => {},
  };
}

async function registerWithGroups() {
  const { createConversationSurfaceRuntime } = await import("../../../engine/conversation-surface-runtime.js");
  const main = fakeLoop(MAIN_CHAT_GROUP_ID, [{ role: "user", content: "from main" }]);
  const groups = new Map<string, FakeLoop>();
  const resolveChatGroupLoop = vi.fn((chatGroupId: string) => {
    let loop = groups.get(chatGroupId);
    if (!loop) { loop = fakeLoop(chatGroupId); groups.set(chatGroupId, loop); }
    return loop;
  });
  const releaseChatGroupLoop = vi.fn((chatGroupId: string) => { groups.delete(chatGroupId); });
  const { registerChatHandlers } = await import("../chat.js");
  registerChatHandlers({
    conversationLoop: main,
    conversationSurfaceRuntime: createConversationSurfaceRuntime(),
    resolveChatGroupLoop,
    releaseChatGroupLoop,
    settingsService: {
      get: vi.fn((key?: string) => (key === "llm" ? fakeLlmSettings() : {})),
      patch: vi.fn(async () => undefined),
    },
    memoryManager: {
      loadMainActiveSessionState: vi.fn(() => null),
      markMainActiveFresh: vi.fn(async () => undefined),
      saveSessionMetadata: vi.fn(async () => undefined),
    },
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => null),
  } as unknown as Parameters<typeof registerChatHandlers>[0]);
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(RENDERER_EVENT, ...args);
  return { main, groups, resolveChatGroupLoop, releaseChatGroupLoop, invoke };
}

describe("lvis:chat:* with chat groups", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it("names its group or is refused — there is no default tile", async () => {
    const { invoke, resolveChatGroupLoop } = await registerWithGroups();
    expect(() => invoke(CHANNELS.chat.hasProvider)).toThrow("chat-group-required");
    expect(() => invoke(CHANNELS.chat.hasProvider, "   ")).toThrow("chat-group-required");
    expect(resolveChatGroupLoop).not.toHaveBeenCalled();
  });

  it("runs each group on its own loop, and the primary on the primary", async () => {
    const { invoke, main, groups, resolveChatGroupLoop } = await registerWithGroups();
    expect(invoke(CHANNELS.chat.hasProvider, MAIN_CHAT_GROUP_ID)).toBe(false);
    expect(invoke(CHANNELS.chat.hasProvider, "group-2")).toBe(true);
    expect(invoke(CHANNELS.chat.hasProvider, "group-3")).toBe(true);
    expect(resolveChatGroupLoop.mock.calls.map((call) => call[0])).toEqual(["group-2", "group-3"]);
    expect(main.hasProvider).toHaveBeenCalledTimes(1);
    expect(groups.get("group-2")!.hasProvider).toHaveBeenCalledTimes(1);
    expect(groups.get("group-3")!.hasProvider).toHaveBeenCalledTimes(1);
    // Resolved once per group, then cached: a second call must not build twice.
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(resolveChatGroupLoop).toHaveBeenCalledTimes(2);
  });

  it("replays a group's OWN history — continue and retry read the tile's conversation, not the primary's", async () => {
    const { invoke, groups } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const loop = groups.get("group-2")!;
    // The primary holds a user message; this group holds none. Reading the
    // primary's history here would find one and go on to run a turn.
    const result = await invoke(CHANNELS.chat.continueLastUser, { sessionId: loop.sessionId }, "group-2");
    expect(result).toEqual({ ok: false, error: "no-user-message" });
    const retried = await invoke(CHANNELS.chat.retryEffort, {}, "group-2");
    expect(retried).toEqual({ ok: false, error: "no-user-message" });
    // And the session check is against the group's session, not the primary's.
    const mismatched = await invoke(CHANNELS.chat.continueLastUser, { sessionId: "session-of-main" }, "group-2");
    expect(mismatched).toEqual({ ok: false, error: "session-mismatch" });
  });

  it("releases a closed tile's group: turn stopped, loop forgotten, a later use builds afresh", async () => {
    const { invoke, groups, resolveChatGroupLoop, releaseChatGroupLoop } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const first = groups.get("group-2")!;
    expect(await invoke(CHANNELS.chat.groupRelease, "group-2")).toEqual({ ok: true, released: true });
    expect(first.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(releaseChatGroupLoop).toHaveBeenCalledWith("group-2");
    expect(await invoke(CHANNELS.chat.groupRelease, "group-2")).toEqual({ ok: true, released: false });
    // The primary is never released.
    expect(await invoke(CHANNELS.chat.groupRelease, MAIN_CHAT_GROUP_ID)).toEqual({ ok: false, error: "invalid-args" });
    // A name reaching main again after release builds a new group, not the old one.
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(resolveChatGroupLoop).toHaveBeenCalledTimes(2);
    expect(groups.get("group-2")).not.toBe(first);
  });

  it("refuses a non-primary group when the process cannot release one", async () => {
    const { createConversationSurfaceRuntime } = await import("../../../engine/conversation-surface-runtime.js");
    const { registerChatHandlers } = await import("../chat.js");
    registerChatHandlers({
      conversationLoop: fakeLoop(MAIN_CHAT_GROUP_ID),
      conversationSurfaceRuntime: createConversationSurfaceRuntime(),
      resolveChatGroupLoop: vi.fn((id: string) => fakeLoop(id)),
      settingsService: { get: vi.fn(() => fakeLlmSettings()), patch: vi.fn(async () => undefined) },
      memoryManager: {},
      auditLogger: { log: vi.fn() },
      getMainWindow: vi.fn(() => null),
    } as unknown as Parameters<typeof registerChatHandlers>[0]);
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(RENDERER_EVENT, ...args);
    expect(() => invoke(CHANNELS.chat.hasProvider, "group-2")).toThrow("chat-groups-unavailable");
  });
});
