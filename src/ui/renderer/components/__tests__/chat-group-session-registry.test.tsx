import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import {
  ChatGroupSessionRegistry,
  useChatGroupSession,
  useRegisterChatGroupSession,
  type ChatGroupSessionHandle,
} from "../chat-group-session-registry.js";

// `entries` identity is the store's change signal — useChatState owns it as
// state and replaces it only when the transcript actually changes. A fresh
// array literal per render would be a caller breaking that contract.
const NO_ENTRIES: readonly ChatEntry[] = [];

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
  currentSessionProject: {},
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
