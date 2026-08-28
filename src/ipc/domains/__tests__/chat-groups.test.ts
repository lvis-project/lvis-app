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

// Every group's frames leave through one adapter subscription; releasing the
// group must let go of it. The adapter is real except that the unsubscribe
// it hands back is observable.
const unsubscribes: ReturnType<typeof vi.fn>[] = [];
vi.mock("../../../api/platform-conversation-legacy-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/platform-conversation-legacy-adapter.js")>();
  return {
    ...actual,
    createPlatformConversationLegacyStreamAdapter: (...args: Parameters<typeof actual.createPlatformConversationLegacyStreamAdapter>) => {
      const adapter = actual.createPlatformConversationLegacyStreamAdapter(...args);
      return {
        ...adapter,
        subscribe: (fn: Parameters<typeof adapter.subscribe>[0]) => {
          const real = adapter.subscribe(fn);
          const spy = vi.fn(real);
          unsubscribes.push(spy);
          return spy;
        },
      };
    },
  };
});

// Every surface runtime the registrar builds, in order — the primary's first,
// then one per group. A group's leases live on its own.
const runtimes: import("../../../engine/conversation-surface-runtime.js").ConversationSurfaceRuntime[] = [];
vi.mock("../../../engine/conversation-surface-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../engine/conversation-surface-runtime.js")>();
  return {
    ...actual,
    createConversationSurfaceRuntime: (...args: Parameters<typeof actual.createConversationSurfaceRuntime>) => {
      const runtime = actual.createConversationSurfaceRuntime(...args);
      runtimes.push(runtime);
      return runtime;
    },
  };
});

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
  resetAndResume: ReturnType<typeof vi.fn>;
};

function fakeLoop(id: string, messages: unknown[] = []): FakeLoop {
  const loop: FakeLoop = {
    id,
    sessionId: `session-of-${id}`,
    hasProvider: vi.fn(() => id !== MAIN_CHAT_GROUP_ID),
    abortCurrentTurn: vi.fn(),
    getSessionId: () => loop.sessionId,
    getSessionKind: () => "main",
    hasActiveTurn: () => false,
    getHistory: () => ({ length: messages.length, getMessages: () => messages, truncate: () => {}, restore: () => {} }),
    refreshProvider: () => {},
    resetAndResume: vi.fn((sessionId: string) => {
      loop.sessionId = sessionId;
      return { ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }),
  };
  return loop;
}

type RendererEvents = Record<string, ((...args: unknown[]) => void)[]>;

async function registerWithGroups(window?: { webContents: { on: (name: string, fn: (...args: unknown[]) => void) => void } }) {
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
  const memoryManager = {
    loadMainActiveSessionState: vi.fn(() => null),
    markMainActiveFresh: vi.fn(async () => undefined),
    markMainActiveResume: vi.fn(async () => undefined),
    saveSessionMetadata: vi.fn(async () => undefined),
  };
  registerChatHandlers({
    conversationLoop: main,
    conversationSurfaceRuntime: createConversationSurfaceRuntime(),
    resolveChatGroupLoop,
    releaseChatGroupLoop,
    settingsService: {
      get: vi.fn((key?: string) => (key === "llm" ? fakeLlmSettings() : {})),
      patch: vi.fn(async () => undefined),
    },
    memoryManager,
    auditLogger: { log: vi.fn() },
    getMainWindow: vi.fn(() => window ?? null),
  } as unknown as Parameters<typeof registerChatHandlers>[0]);
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!(RENDERER_EVENT, ...args);
  return { main, groups, resolveChatGroupLoop, releaseChatGroupLoop, invoke, memoryManager };
}

function fakeRenderer(): { window: { webContents: { on: (name: string, fn: (...args: unknown[]) => void) => void } }; events: RendererEvents } {
  const events: RendererEvents = {};
  const on = (name: string, fn: (...args: unknown[]) => void) => { (events[name] ??= []).push(fn); };
  return { window: { webContents: { on } }, events };
}

describe("lvis:chat:* with chat groups", () => {
  beforeEach(() => {
    handlers.clear();
    unsubscribes.length = 0;
    runtimes.length = 0;
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

  it("opens a session in one tile at a time — a resume of one another tile holds is refused", async () => {
    const { invoke, groups, main } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    const second = groups.get("group-2")!;

    // The primary's conversation cannot be pulled into the second tile...
    // ...and the refusal names the holder, so the renderer can bring it forward.
    const refused = await invoke(CHANNELS.chat.sessionResume, "session-of-main", "group-2");
    expect(refused).toMatchObject({ ok: false, error: "session-open-in-other-group", holderChatGroupId: MAIN_CHAT_GROUP_ID });
    expect(second.resetAndResume).not.toHaveBeenCalled();
    // ...and the second tile's cannot be pulled into the primary.
    const refusedBack = await invoke(CHANNELS.chat.sessionResume, "session-of-group-2", MAIN_CHAT_GROUP_ID);
    expect(refusedBack).toMatchObject({ ok: false, error: "session-open-in-other-group", holderChatGroupId: "group-2" });
    expect(main.resetAndResume).not.toHaveBeenCalled();

    // A conversation no tile holds loads normally.
    const loaded = await invoke(CHANNELS.chat.sessionResume, "session-archived", "group-2");
    expect(loaded).toMatchObject({ ok: true });
    expect(second.resetAndResume).toHaveBeenCalledWith("session-archived");
  });

  it("only the primary tile's resume becomes the window's main-active conversation", async () => {
    const { invoke, memoryManager } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");

    await invoke(CHANNELS.chat.sessionResume, "session-archived", "group-2");
    expect(memoryManager.markMainActiveResume).not.toHaveBeenCalled();

    await invoke(CHANNELS.chat.sessionResume, "session-older", MAIN_CHAT_GROUP_ID);
    expect(memoryManager.markMainActiveResume).toHaveBeenCalledWith("session-older");
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

  it("release lets go of the group's frames, and waits for a turn that is still running", async () => {
    const { invoke, groups } = await registerWithGroups();
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(unsubscribes).toHaveLength(2); // the primary's, then group-2's
    const groupRuntime = runtimes[1]!;
    let finishTurn!: () => void;
    const lease = groupRuntime.activity.tryTrackTurn(() => new Promise<void>((resolve) => { finishTurn = resolve; }));
    expect(lease).not.toBeNull();
    let settled = false;
    const release = (invoke(CHANNELS.chat.groupRelease, "group-2") as Promise<unknown>).then((r) => { settled = true; return r; });
    await Promise.resolve();
    expect(groups.get("group-2")!.abortCurrentTurn).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); // still waiting on the turn's lease
    finishTurn();
    expect(await release).toEqual({ ok: true, released: true });
    expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
    expect(unsubscribes[0]).not.toHaveBeenCalled(); // the primary keeps its frames
  });

  it("lets every group go when the renderer navigates — a reload numbers its tiles from the start", async () => {
    const { window, events } = fakeRenderer();
    const { invoke, groups, resolveChatGroupLoop, releaseChatGroupLoop } = await registerWithGroups(window);
    invoke(CHANNELS.chat.hasProvider, "group-2");
    invoke(CHANNELS.chat.hasProvider, "group-3");
    const before = groups.get("group-2")!;
    expect(events["did-start-navigation"]).toHaveLength(1); // installed once, not per group
    // An in-page navigation is not a reload.
    events["did-start-navigation"]![0]!({ isMainFrame: true, isSameDocument: true });
    expect(releaseChatGroupLoop).not.toHaveBeenCalled();
    events["did-start-navigation"]![0]!({ isMainFrame: true, isSameDocument: false });
    await Promise.resolve();
    expect(releaseChatGroupLoop.mock.calls.map((call) => call[0]).sort()).toEqual(["group-2", "group-3"]);
    // The reloaded renderer's first extra tile is "group-2" again — and gets a new loop.
    invoke(CHANNELS.chat.hasProvider, "group-2");
    expect(resolveChatGroupLoop).toHaveBeenCalledTimes(3);
    expect(groups.get("group-2")).not.toBe(before);
    // A dead render process is the same story.
    invoke(CHANNELS.chat.hasProvider, "group-4");
    events["render-process-gone"]![0]!();
    await Promise.resolve();
    expect(releaseChatGroupLoop).toHaveBeenLastCalledWith("group-4");
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
