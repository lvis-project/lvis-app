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
  tileDrawsSession,
  tileHoldingSession,
  overlayCardTile,
} from "../chat-group-session-registry.js";

// `entries` identity is the store's change signal — useChatState owns it as
// state and replaces it only when the transcript actually changes. A fresh
// array literal per render would be a caller breaking that contract.
const NO_ENTRIES: readonly ChatEntry[] = [];
// The question queue follows the same reference-identity contract as entries.
const NO_ASK_QUESTIONS: readonly [] = [];
// Same contract for the project summary: it is `useState` in the tile, so its
// identity changes only when the session's project does.
const NO_PROJECT: SessionProjectSummary = {};

const handleFor = (streaming: boolean, entries: readonly ChatEntry[] = NO_ENTRIES): ChatGroupSessionHandle => ({
  entries,
  streaming,
  hidden: false,
  paneHidden: false,
  askQuestions: NO_ASK_QUESTIONS,
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
    expect(registry.readTiles()).toEqual([
      { chatGroupId: "main", sessionId: "s-1", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
      { chatGroupId: "group-2", sessionId: "s-2", streaming: true, hidden: false, paneHidden: false, askQuestions: [] },
    ]);
    registry.retract("group-2");
    expect(registry.readTiles()).toEqual([{ chatGroupId: "main", sessionId: "s-1", streaming: false, hidden: false, paneHidden: false, askQuestions: [] }]);
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
    expect(result.current).toEqual([{ chatGroupId: "group-2", sessionId: "s-2", streaming: true, hidden: false, paneHidden: false, askQuestions: [] }]);
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

describe("overlayCardTile", () => {
  const tiles = [
    { chatGroupId: "main", sessionId: "s-1", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
    { chatGroupId: "group-2", sessionId: "s-2", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
  ];

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
    // board fell out to the window band.
    const routed = [
      { chatGroupId: "main", sessionId: "s-1", streaming: false, hidden: true, paneHidden: false, askQuestions: [] },
      { chatGroupId: "group-2", sessionId: "s-2", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
    ];
    expect(overlayCardTile(routed, "main", {})).toEqual({
      chatGroupId: "main",
      orphaned: false,
    });
    expect(overlayCardTile(routed, "group-2", { originSessionId: "s-1" })).toEqual({
      chatGroupId: "main",
      orphaned: false,
    });
    // The composer-bound routing still reads `hidden`: the routed pane's own
    // question is not drawn into a composer nobody sees.
    expect(tileDrawsSession({
      tiles: routed, sessionId: "s-1", owned: true, focused: true, hidden: true,
    })).toBe(false);
  });

  it("hands a card for a pane the tree is not drawing to the window instead, because that pane paints nothing", () => {
    // A tile the tree is not drawing stays MOUNTED so its conversation's turn
    // keeps its stream subscription. It still holds that conversation — but
    // nothing of it is on screen, not even its frame, so a card given to it is
    // a card nobody can see.
    const hidden = [
      { chatGroupId: "main", sessionId: "s-1", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
      { chatGroupId: "group-2", sessionId: "s-2", streaming: true, hidden: true, paneHidden: true, askQuestions: [] },
    ];
    expect(overlayCardTile(hidden, "main", { originSessionId: "s-2" })).toEqual({
      chatGroupId: null,
      orphaned: true,
    });
    // Focus resting on a pane the tree is not drawing draws nowhere the user
    // can see; the band shows the card until a drawn pane is focused.
    expect(overlayCardTile(hidden, "group-2", {})).toEqual({
      chatGroupId: null,
      orphaned: false,
    });
    // …and the focused tile adopts a question for that conversation, rather
    // than leaving it to the tile that holds it and draws nothing.
    expect(tileDrawsSession({
      tiles: hidden, sessionId: "s-2", owned: false, focused: true, hidden: false,
    })).toBe(true);
    // The other half of the same answer, and the one that decides whether the
    // card is drawn ONCE: the hidden tile owns "s-2" and must still decline.
    // Owning is the ordinary case while its turn runs off-screen, so an
    // ownership check that ran first would draw the card twice — invisibly
    // here, and again in the tile that adopted it above. Only the second copy
    // can be answered, and the first would outlive the answer.
    expect(tileDrawsSession({
      tiles: hidden, sessionId: "s-2", owned: true, focused: false, hidden: true,
    })).toBe(false);
  });

  it("sends an unowned card to the window's own chrome only when no pane is drawn", () => {
    expect(overlayCardTile([], "main", {})).toEqual({
      chatGroupId: null,
      orphaned: false,
    });
  });

  it("shows an orphaned card in the window's chrome, marked as having no origin", () => {
    // Its conversation is gone; nothing on screen can run its action, and the
    // window says so rather than drawing an action that would run elsewhere.
    expect(overlayCardTile(tiles, "main", { originSessionId: "s-gone" })).toEqual({
      chatGroupId: null,
      orphaned: true,
    });
  });
});

describe("tileDrawsSession", () => {
  // Two tiles, each showing a conversation of its own. "main" is focused.
  const tiles = [
    { chatGroupId: "main", sessionId: "s-main", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
    { chatGroupId: "group-2", sessionId: "s-other", streaming: false, hidden: false, paneHidden: false, askQuestions: [] },
  ];

  it("adopts a routine's headless session into the focused tile, and only that tile", () => {
    // A routine turn runs in a session no tile is showing. Its question has to
    // land somewhere or the gate waits out its timeout against a blank window.
    const routineSession = "s-routine";
    expect(tileDrawsSession({ tiles, sessionId: routineSession, owned: false, focused: true, hidden: false })).toBe(true);
    expect(tileDrawsSession({ tiles, sessionId: routineSession, owned: false, focused: false, hidden: false })).toBe(false);
  });

  it("never adopts a session another tile is showing — that tile draws it", () => {
    expect(tileDrawsSession({ tiles, sessionId: "s-other", owned: false, focused: true, hidden: false })).toBe(false);
  });

  it("adopts a background child whose parent tile has since switched conversations", () => {
    // The switch cleared the parent's spawn list, so the child is no longer
    // owned by anyone and no tile holds its session.
    expect(tileDrawsSession({ tiles, sessionId: "s-background-child", owned: false, focused: true, hidden: false })).toBe(true);
  });

  it("draws its own conversation whether or not it is the focused tile", () => {
    expect(tileDrawsSession({ tiles, sessionId: "s-main", owned: true, focused: false, hidden: false })).toBe(true);
  });
});
