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
} from "../chat-group-session-registry.js";

// `entries` identity is the store's change signal — useChatState owns it as
// state and replaces it only when the transcript actually changes. A fresh
// array literal per render would be a caller breaking that contract.
const NO_ENTRIES: readonly ChatEntry[] = [];
// Same contract for the project summary: it is `useState` in the tile, so its
// identity changes only when the session's project does.
const NO_PROJECT: SessionProjectSummary = {};

const handleFor = (streaming: boolean, entries: readonly ChatEntry[] = NO_ENTRIES): ChatGroupSessionHandle => ({
  entries,
  streaming,
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
      { chatGroupId: "main", sessionId: "s-1", streaming: false },
      { chatGroupId: "group-2", sessionId: "s-2", streaming: true },
    ]);
    registry.retract("group-2");
    expect(registry.readTiles()).toEqual([{ chatGroupId: "main", sessionId: "s-1", streaming: false }]);
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
    expect(result.current).toEqual([{ chatGroupId: "group-2", sessionId: "s-2", streaming: true }]);
    act(() => registry.retract("group-2"));
    expect(result.current).toEqual([]);
  });
});
