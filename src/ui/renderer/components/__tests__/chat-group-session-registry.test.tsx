import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { SessionProjectSummary } from "../../hooks/use-sessions.js";
import {
  ChatGroupSessionRegistry,
  useChatGroupSession,
  useRegisterChatGroupSession,
  useTileSessions,
  type ChatGroupSessionHandle,
  type TileSession,
  tileDrawsSession,
  tileHoldingSession,
  overlayCardTile,
  pendingAnswers,
} from "../chat-group-session-registry.js";
import type { ApprovalRequest } from "../../types.js";

// `entries` identity is the store's change signal — useChatState owns it as
// state and replaces it only when the transcript actually changes. A fresh
// array literal per render would be a caller breaking that contract.
const NO_ENTRIES: readonly ChatEntry[] = [];
// The question queue follows the same reference-identity contract as entries.
const NO_ASK_QUESTIONS: readonly [] = [];
// Same contract for the project summary: it is `useState` in the tile, so its
// identity changes only when the session's project does.
const NO_PROJECT: SessionProjectSummary = {};

const NO_CHILDREN: ReadonlySet<string> = new Set();

/** A tile as the window's selectors see it; every field the tree can vary is a knob. */
const tile = (
  chatGroupId: string,
  sessionId: string,
  overrides: Partial<TileSession> = {},
): TileSession => ({
  chatGroupId,
  sessionId,
  streaming: false,
  hidden: false,
  paneHidden: false,
  askQuestions: [],
  childSessionIds: NO_CHILDREN,
  sideChat: null,
  ...overrides,
});

const handleFor = (streaming: boolean, entries: readonly ChatEntry[] = NO_ENTRIES): ChatGroupSessionHandle => ({
  entries,
  streaming,
  hidden: false,
  paneHidden: false,
  askQuestions: NO_ASK_QUESTIONS,
  childSessionIds: NO_CHILDREN,
  sideChat: null,
  resolveAskQuestion: () => {},
  applyLoadedSession: () => {},
  applyInitialSession: () => {},
  clearForNewChat: () => {},
  resetForNewSession: () => {},
  restoreSubAgentSpawns: () => {},
  ask: async () => {},
  insertImportedTriggerEntry: () => {},
  currentSessionId: "",
  currentSessionProject: NO_PROJECT,
  loadSession: async () => false,
  fallbackToast: null,
  prefillComposer: () => {},
  appendSystemEntry: () => {},
  startNewChat: async () => {},
});

describe("ChatGroupSessionRegistry", () => {
  it("wakes only the subscribers of the group that changed", () => {
    // A tile that streams must not re-render the tiles beside it.
    const registry = new ChatGroupSessionRegistry();
    const onMain = vi.fn();
    const onOther = vi.fn();
    registry.subscribe("main", onMain);
    registry.subscribe("group-2", onOther);

    registry.publish("main", handleFor(true));

    expect(onMain).toHaveBeenCalledTimes(1);
    expect(onOther).not.toHaveBeenCalled();
  });

  it("stops waking a listener once it unsubscribes", () => {
    const registry = new ChatGroupSessionRegistry();
    const listener = vi.fn();
    const off = registry.subscribe("main", listener);

    off();
    registry.publish("main", handleFor(true));

    expect(listener).not.toHaveBeenCalled();
  });

  it("says nothing changed when retracting a group it never held", () => {
    const registry = new ChatGroupSessionRegistry();
    const listener = vi.fn();
    registry.subscribe("main", listener);

    registry.retract("main");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("useChatGroupSession", () => {
  it("reports a quiet stand-in before any tile has published", () => {
    // First paint happens before the publishing effect runs. Reporting
    // "streaming" here would leave the window's controls stuck disabled.
    const registry = new ChatGroupSessionRegistry();

    const { result } = renderHook(() => useChatGroupSession(registry, "main"));

    expect(result.current.streaming).toBe(false);
    expect(result.current.entries).toEqual([]);
    expect(() => result.current.clearForNewChat()).not.toThrow();
  });

  it("follows the registered tile, including later updates to it", () => {
    const registry = new ChatGroupSessionRegistry();
    const { result, rerender } = renderHook(
      ({ streaming }) => {
        useRegisterChatGroupSession(registry, "main", handleFor(streaming));
        return useChatGroupSession(registry, "main");
      },
      { initialProps: { streaming: false } },
    );

    expect(result.current.streaming).toBe(false);
    act(() => rerender({ streaming: true }));
    // A handle captured once would leave the toolbar enabled through a turn.
    expect(result.current.streaming).toBe(true);
  });

  it("falls back to the stand-in when the tile unmounts", () => {
    const registry = new ChatGroupSessionRegistry();
    const tile = renderHook(() => useRegisterChatGroupSession(registry, "group-2", handleFor(true)));
    const reader = renderHook(() => useChatGroupSession(registry, "group-2"));

    expect(reader.result.current.streaming).toBe(true);
    act(() => tile.unmount());
    reader.rerender();

    expect(reader.result.current.streaming).toBe(false);
  });

  it("keeps groups apart", () => {
    const registry = new ChatGroupSessionRegistry();
    renderHook(() => useRegisterChatGroupSession(registry, "main", handleFor(true)));
    const other = renderHook(() => useChatGroupSession(registry, "group-2"));

    expect(other.result.current.streaming).toBe(false);
  });
});

describe("tile sessions — every tile at once", () => {
  const holding = (sessionId: string, streaming: boolean): ChatGroupSessionHandle =>
    ({ ...handleFor(streaming), currentSessionId: sessionId });

  it("lists every tile's conversation and streaming state, in publish order", () => {
    const registry = new ChatGroupSessionRegistry();
    registry.publish("main", holding("s-1", false));
    registry.publish("group-2", holding("s-2", true));
    expect(registry.readTiles()).toEqual([tile("main", "s-1"), tile("group-2", "s-2", { streaming: true })]);
    registry.retract("group-2");
    expect(registry.readTiles()).toEqual([tile("main", "s-1")]);
  });

  it("keeps the same array while only transcripts change — tokens must not re-render the sidebar", () => {
    const registry = new ChatGroupSessionRegistry();
    const woken = vi.fn();
    registry.subscribeTiles(woken);
    registry.publish("main", holding("s-1", true));
    const first = registry.readTiles();
    expect(woken).toHaveBeenCalledTimes(1);
    registry.publish("main", { ...holding("s-1", true), entries: [{ role: "assistant", content: "…" } as unknown as ChatEntry] });
    expect(registry.readTiles()).toBe(first);
    expect(woken).toHaveBeenCalledTimes(1);
    registry.publish("main", holding("s-1", false));
    expect(registry.readTiles()).not.toBe(first);
    expect(registry.readTiles()[0]!.streaming).toBe(false);
    expect(woken).toHaveBeenCalledTimes(2);
  });

  it("keeps the same array when another tile republishes with nothing tile-visible changed", () => {
    const registry = new ChatGroupSessionRegistry();
    registry.publish("main", holding("s-1", false));
    registry.publish("group-2", holding("s-2", true));
    const first = registry.readTiles();
    registry.publish("main", { ...holding("s-1", false), entries: [{ role: "user", content: "…" } as unknown as ChatEntry] });
    expect(registry.readTiles()).toBe(first);
  });

  it("useTileSessions follows the store", () => {
    const registry = new ChatGroupSessionRegistry();
    const { result } = renderHook(() => useTileSessions(registry));
    expect(result.current).toEqual([]);
    act(() => registry.publish("group-2", holding("s-2", true)));
    expect(result.current).toEqual([tile("group-2", "s-2", { streaming: true })]);
    act(() => registry.retract("group-2"));
    expect(result.current).toEqual([]);
  });
});

describe("tileHoldingSession", () => {
  it("names the tile already holding a conversation, and nothing when none does", () => {
    const tiles = [
      { chatGroupId: "main", sessionId: "s-1", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
      { chatGroupId: "group-2", sessionId: "s-2", streaming: true, hidden: false, paneHidden: false, askQuestions: [] },
    ];
    expect(tileHoldingSession(tiles, "s-2")?.chatGroupId).toBe("group-2");
    expect(tileHoldingSession(tiles, "s-9")).toBeUndefined();
  });
});

const approval = (id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id,
  toolName: "bash",
  args: {},
  category: "shell",
  kind: "rationale",
  ...overrides,
} as ApprovalRequest);

const question = (id: string, sessionId: string) => ({
  id,
  sessionId,
  questions: [{ question: "?", choices: ["yes", "no"] }],
  createdAt: 0,
});

describe("overlayCardTile", () => {
  const tiles = [tile("main", "s-1"), tile("group-2", "s-2")];

  it("sends a card to the tile holding the conversation it came from", () => {
    // Which tile is focused does not enter into it: the card's action
    // continues the conversation it was raised in, which may be sitting
    // unfocused beside the one the user is typing in.
    expect(overlayCardTile(tiles, "main", { originSessionId: "s-2" })).toEqual({
      chatGroupId: "group-2",
      orphaned: false,
    });
    expect(overlayCardTile(tiles, "group-2", { originSessionId: "s-1" })).toEqual({
      chatGroupId: "main",
      orphaned: false,
    });
  });

  it("draws a card with no conversation behind it in the focused pane, and follows focus", () => {
    // The window's queue of unowned cards has one reader, the user, who is at
    // the focused pane. Read at render time, so a focus move moves the card:
    // one card, where the user is, however many panes are open.
    expect(overlayCardTile(tiles, "group-2", {})).toEqual({ chatGroupId: "group-2", orphaned: false });
    expect(overlayCardTile(tiles, "main", {})).toEqual({ chatGroupId: "main", orphaned: false });
  });

  it("keeps a card in a focused pane that is routed off its conversation — the lane is the pane frame's", () => {
    // A pane showing Settings or a plugin view hides its CONVERSATION, not
    // itself: `hidden` is true for the composer-bound cards, `paneHidden` is
    // not. The overlay lane belongs to the frame, so the card is drawn in the
    // pane. The defect this guards: a card shown over a pane showing the work
    // board fell out of the pane.
    const routed = [tile("main", "s-1", { hidden: true }), tile("group-2", "s-2")];
    expect(overlayCardTile(routed, "main", {})).toEqual({
      chatGroupId: "main",
      orphaned: false,
    });
    expect(overlayCardTile(routed, "group-2", { originSessionId: "s-1" })).toEqual({
      chatGroupId: "main",
      orphaned: false,
    });
    // The routed pane still draws its own conversation's question — in the
    // routed frame's settle slot, not over a composer nobody sees.
    expect(tileDrawsSession({ tiles: routed, sessionId: "s-1", owned: true, focused: true })).toBe(true);
  });

  it("draws nothing for a pane the tree is not drawing — the card waits there, and the row gets the dot", () => {
    // A tile the tree is not drawing stays MOUNTED so its conversation's turn
    // keeps its stream subscription. It still holds that conversation — but
    // nothing of it is on screen, not even its frame, so a card given to it is
    // a card nobody can see. It is not handed to another pane: it is that
    // conversation's card, and the way to it is the sidebar row.
    const hidden = [tile("main", "s-1"), tile("group-2", "s-2", { streaming: true, hidden: true, paneHidden: true })];
    expect(overlayCardTile(hidden, "main", { originSessionId: "s-2" })).toEqual({
      chatGroupId: null,
      orphaned: true,
    });
    // Focus resting on a pane the tree is not drawing draws nowhere the user
    // can see; the card waits until a drawn pane is focused.
    expect(overlayCardTile(hidden, "group-2", {})).toEqual({
      chatGroupId: null,
      orphaned: false,
    });
    // The hidden tile keeps its own question; the focused tile never adopts a
    // session some tile holds, drawn or not — or the card would be drawn twice
    // once the hidden pane came back, and only one copy could be answered.
    expect(tileDrawsSession({ tiles: hidden, sessionId: "s-2", owned: false, focused: true })).toBe(false);
    expect(tileDrawsSession({ tiles: hidden, sessionId: "s-2", owned: true, focused: false })).toBe(true);
  });

  it("draws an unowned card nowhere while no pane is drawn", () => {
    expect(overlayCardTile([], "main", {})).toEqual({
      chatGroupId: null,
      orphaned: false,
    });
  });

  it("marks an orphaned card as having no origin on screen", () => {
    // Its conversation is gone; nothing on screen can run its action, and the
    // selector says so rather than drawing an action that would run elsewhere.
    expect(overlayCardTile(tiles, "main", { originSessionId: "s-gone" })).toEqual({
      chatGroupId: null,
      orphaned: true,
    });
  });
});

describe("tileDrawsSession", () => {
  // Two tiles, each showing a conversation of its own. "main" is focused.
  const tiles = [tile("main", "s-main"), tile("group-2", "s-other")];

  it("adopts a routine's headless session into the focused tile, and only that tile", () => {
    // A routine turn runs in a session no tile is showing. Its question has to
    // land somewhere or the gate waits out its timeout against a blank window.
    const routineSession = "s-routine";
    expect(tileDrawsSession({ tiles, sessionId: routineSession, owned: false, focused: true })).toBe(true);
    expect(tileDrawsSession({ tiles, sessionId: routineSession, owned: false, focused: false })).toBe(false);
  });

  it("never adopts a session another tile is showing — that tile draws it", () => {
    expect(tileDrawsSession({ tiles, sessionId: "s-other", owned: false, focused: true })).toBe(false);
  });

  it("never adopts a child another tile spawned — the parent tile draws it", () => {
    const withChild = [tile("main", "s-main"), tile("group-2", "s-other", { childSessionIds: new Set(["s-child"]) })];
    expect(tileDrawsSession({ tiles: withChild, sessionId: "s-child", owned: false, focused: true })).toBe(false);
  });

  it("never adopts a side chat's session — the side chat is a drawing surface of its own", () => {
    const withSideChat = [
      tile("main", "s-main", { sideChat: { sessionId: "s-side", askQuestions: [], shown: true } }),
      tile("group-2", "s-other"),
    ];
    // The tile beside it, focused, leaves it alone…
    expect(tileDrawsSession({ tiles: withSideChat, sessionId: "s-side", owned: false, focused: true })).toBe(false);
    // …and so does the tile that holds the side chat: the side chat draws.
    expect(tileDrawsSession({ tiles: withSideChat, sessionId: "s-side", owned: false, focused: false })).toBe(false);
  });

  it("adopts a background child whose parent tile has since switched conversations", () => {
    // The switch cleared the parent's spawn list, so the child is no longer
    // owned by anyone and no tile holds its session.
    expect(tileDrawsSession({ tiles, sessionId: "s-background-child", owned: false, focused: true })).toBe(true);
  });

  it("draws its own conversation whether or not it is the focused tile", () => {
    expect(tileDrawsSession({ tiles, sessionId: "s-main", owned: true, focused: false })).toBe(true);
  });
});

describe("pendingAnswers", () => {
  const sessions = [
    { id: "s-main", family: "main" as const },
    { id: "s-other", family: "main" as const },
    { id: "s-routine", family: "routine" as const },
    { id: "s-board", family: "work-board" as const },
    { id: "s-side", family: "side-chat" as const, originSessionId: "s-main" },
  ];
  const empty = { approvals: [], deferredSessionIds: [], overlayCards: [], sessions };

  it("marks nothing for a card the user can already see", () => {
    // Over a drawn pane's composer or in its settle slot — no dot anywhere.
    const tiles = [tile("main", "s-main", { askQuestions: [question("q1", "s-main")] })];
    const result = pendingAnswers({ ...empty, tiles, approvals: [approval("a1", { sessionId: "s-main" })] });
    expect(result.sessionIds.size).toBe(0);
    expect(result.hiddenPaneIds.size).toBe(0);
    expect(result.unattributed).toEqual([]);
  });

  it("marks a routed pane's conversation nowhere — its routed frame draws the card", () => {
    const tiles = [tile("main", "s-main", { hidden: true, askQuestions: [question("q1", "s-main")] })];
    const result = pendingAnswers({ ...empty, tiles, approvals: [approval("a1", { sessionId: "s-main" })] });
    expect(result.sessionIds.size).toBe(0);
    expect(result.hiddenPaneIds.size).toBe(0);
  });

  it("marks the row and the pane of a conversation the tree hides — approval, question, child, deferred, overlay", () => {
    const hidden = { hidden: true, paneHidden: true };
    const cases: Array<[string, Parameters<typeof pendingAnswers>[0]]> = [
      ["approval", { ...empty, tiles: [tile("g2", "s-other", hidden)], approvals: [approval("a1", { sessionId: "s-other" })] }],
      ["question", { ...empty, tiles: [tile("g2", "s-other", { ...hidden, askQuestions: [question("q1", "s-other")] })] }],
      ["child approval", { ...empty, tiles: [tile("g2", "s-other", { ...hidden, childSessionIds: new Set(["s-child"]) })], approvals: [approval("a1", { sessionId: "s-child" })] }],
      ["deferred", { ...empty, tiles: [tile("g2", "s-other", hidden)], deferredSessionIds: ["s-other"] }],
      ["overlay", { ...empty, tiles: [tile("g2", "s-other", hidden)], overlayCards: [{ originSessionId: "s-other" }] }],
    ];
    for (const [name, input] of cases) {
      const result = pendingAnswers(input);
      expect([name, [...result.sessionIds]]).toEqual([name, ["s-other"]]);
      expect([name, [...result.hiddenPaneIds]]).toEqual([name, ["g2"]]);
      expect(result.unattributed).toEqual([]);
    }
  });

  it("marks the row of a listed conversation no pane holds — every family", () => {
    const tiles = [tile("main", "s-main")];
    const result = pendingAnswers({
      ...empty,
      tiles,
      approvals: [
        approval("a1", { sessionId: "s-other" }),
        approval("a2", { sessionId: "s-routine" }),
        approval("a3", { sessionId: "s-board" }),
      ],
      overlayCards: [{ originSessionId: "s-routine" }],
    });
    expect([...result.sessionIds].sort()).toEqual(["s-board", "s-other", "s-routine"]);
    expect(result.hiddenPaneIds.size).toBe(0);
    expect(result.unattributed).toEqual([]);
  });

  it("marks a side chat AND its parent row when the side chat is not on screen", () => {
    // Collapsed panel or another tab active: the tile says `shown: false`.
    const tiles = [tile("main", "s-main", { sideChat: { sessionId: "s-side", askQuestions: [question("q1", "s-side")], shown: false } })];
    const result = pendingAnswers({ ...empty, tiles, approvals: [approval("a1", { sessionId: "s-side" })] });
    expect([...result.sessionIds].sort()).toEqual(["s-main", "s-side"]);
    expect([...result.sideChatSessionIds]).toEqual(["s-side"]);
    expect(result.hiddenPaneIds.size).toBe(0);
  });

  it("marks nothing for a side chat the user is looking at", () => {
    const tiles = [tile("main", "s-main", { sideChat: { sessionId: "s-side", askQuestions: [question("q1", "s-side")], shown: true } })];
    const result = pendingAnswers({ ...empty, tiles, approvals: [approval("a1", { sessionId: "s-side" })] });
    expect(result.sessionIds.size).toBe(0);
    expect(result.sideChatSessionIds.size).toBe(0);
  });

  it("takes a side chat's parent from the list when its own tile has moved on", () => {
    // No tile holds the side chat: the listed row still nests under s-main.
    const result = pendingAnswers({ ...empty, tiles: [tile("main", "s-other")], approvals: [approval("a1", { sessionId: "s-side" })] });
    expect([...result.sessionIds].sort()).toEqual(["s-main", "s-side"]);
    expect([...result.sideChatSessionIds]).toEqual(["s-side"]);
  });

  it("marks the hidden pane too when the side chat's tile is one the tree hides", () => {
    const tiles = [tile("g2", "s-other", { hidden: true, paneHidden: true, sideChat: { sessionId: "s-side", askQuestions: [], shown: true } })];
    const result = pendingAnswers({ ...empty, tiles, approvals: [approval("a1", { sessionId: "s-side" })] });
    expect([...result.sessionIds].sort()).toEqual(["s-main", "s-side"]);
    expect([...result.hiddenPaneIds]).toEqual(["g2"]);
  });

  it("puts a request that names no conversation, or one nothing holds or lists, in the lane", () => {
    const tiles = [tile("main", "s-main")];
    const host = approval("a1");
    const plugin = approval("a2", { sourcePluginId: "some-plugin" });
    const unknown = approval("a3", { sessionId: "s-nobody-knows" });
    const result = pendingAnswers({ ...empty, tiles, approvals: [host, plugin, unknown] });
    expect(result.unattributed).toEqual([host, plugin, unknown]);
    expect(result.sessionIds.size).toBe(0);
  });

  it("marks the asking session's row for a question a hidden tile adopted", () => {
    const tiles = [tile("g2", "s-other", { hidden: true, paneHidden: true, askQuestions: [question("q1", "s-routine")] })];
    const result = pendingAnswers({ ...empty, tiles });
    expect([...result.sessionIds]).toEqual(["s-routine"]);
    expect([...result.hiddenPaneIds]).toEqual(["g2"]);
  });
});
