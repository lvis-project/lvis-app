import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TileSession } from "../../components/chat-group-session-registry.js";
import { turnsEndedUnseen, useTurnAttention } from "../use-sessions.js";

const tile = (chatGroupId: string, sessionId: string, streaming: boolean): TileSession =>
  ({ chatGroupId, sessionId, streaming });

describe("turnsEndedUnseen", () => {
  const looking = { focusedChatGroupId: "main", conversationVisible: true };

  it("names a conversation whose turn ended in a tile the user was not looking at", () => {
    const before = [tile("main", "s-1", false), tile("group-2", "s-2", true)];
    const after = [tile("main", "s-1", false), tile("group-2", "s-2", false)];
    expect(turnsEndedUnseen(before, after, looking)).toEqual(["s-2"]);
  });

  it("says nothing for a turn that ended under the user's eyes", () => {
    const before = [tile("main", "s-1", true)];
    const after = [tile("main", "s-1", false)];
    expect(turnsEndedUnseen(before, after, looking)).toEqual([]);
  });

  it("counts the focused tile as unseen while another view covers the conversation", () => {
    const before = [tile("main", "s-1", true)];
    const after = [tile("main", "s-1", false)];
    expect(turnsEndedUnseen(before, after, { focusedChatGroupId: "main", conversationVisible: false })).toEqual(["s-1"]);
  });

  it("does not mark a conversation the focused tile is showing, even when its turn ran in another tile", () => {
    const before = [tile("main", "s-1", false), tile("group-2", "s-1", true)];
    const after = [tile("main", "s-1", false), tile("group-2", "s-1", false)];
    expect(turnsEndedUnseen(before, after, looking)).toEqual([]);
  });

  it("marks a conversation whose streaming tile left the canvas — the end will never be reported", () => {
    const before = [tile("main", "s-1", false), tile("group-2", "s-2", true)];
    expect(turnsEndedUnseen(before, [tile("main", "s-1", false)], looking)).toEqual(["s-2"]);
    // …unless the focused tile is showing that very conversation.
    expect(turnsEndedUnseen(before, [tile("main", "s-2", false)], looking)).toEqual([]);
  });

  it("ignores a tile that moved to another conversation, a turn still running, and a tile with no session", () => {
    const before = [tile("group-2", "s-2", true), tile("group-3", "s-3", true), tile("group-4", "", true)];
    const after = [tile("group-2", "s-9", false), tile("group-3", "s-3", true), tile("group-4", "", false)];
    expect(turnsEndedUnseen(before, after, looking)).toEqual([]);
  });
});

describe("useTurnAttention", () => {
  function harness(initial: { tiles: readonly TileSession[]; focused: string; visible: boolean; unread?: string[] }) {
    const unread = new Set(initial.unread ?? []);
    const setUnread = vi.fn((sessionId: string, next: boolean) => { if (next) unread.add(sessionId); else unread.delete(sessionId); });
    const hook = renderHook(
      (props: { tiles: readonly TileSession[]; focused: string; visible: boolean }) => useTurnAttention({
        tiles: props.tiles,
        attention: { focusedChatGroupId: props.focused, conversationVisible: props.visible },
        isUnread: (id) => unread.has(id),
        setUnread,
      }),
      { initialProps: { tiles: initial.tiles, focused: initial.focused, visible: initial.visible } },
    );
    return { ...hook, setUnread, unread };
  }

  it("marks a conversation unread when its turn ends in an unfocused tile, and reads it when that tile is focused", () => {
    const running = [tile("main", "s-1", false), tile("group-2", "s-2", true)];
    const { rerender, setUnread, unread } = harness({ tiles: running, focused: "main", visible: true });
    rerender({ tiles: [tile("main", "s-1", false), tile("group-2", "s-2", false)], focused: "main", visible: true });
    expect(setUnread).toHaveBeenLastCalledWith("s-2", true);
    expect(unread.has("s-2")).toBe(true);
    rerender({ tiles: [tile("main", "s-1", false), tile("group-2", "s-2", false)], focused: "group-2", visible: true });
    expect(setUnread).toHaveBeenLastCalledWith("s-2", false);
  });

  it("does not mark a turn that ended in the focused, visible tile", () => {
    const { rerender, setUnread } = harness({ tiles: [tile("main", "s-1", true)], focused: "main", visible: true });
    rerender({ tiles: [tile("main", "s-1", false)], focused: "main", visible: true });
    expect(setUnread).not.toHaveBeenCalled();
  });

  it("marks the focused tile's turn while Settings covers it, and reads it on returning", () => {
    const { rerender, setUnread } = harness({ tiles: [tile("main", "s-1", true)], focused: "main", visible: false });
    rerender({ tiles: [tile("main", "s-1", false)], focused: "main", visible: false });
    expect(setUnread).toHaveBeenLastCalledWith("s-1", true);
    rerender({ tiles: [tile("main", "s-1", false)], focused: "main", visible: true });
    expect(setUnread).toHaveBeenLastCalledWith("s-1", false);
  });

  it("does not write a mark a conversation already carries", () => {
    const { rerender, setUnread } = harness({ tiles: [tile("main", "s-1", false), tile("group-2", "s-2", true)], focused: "main", visible: true, unread: ["s-2"] });
    rerender({ tiles: [tile("main", "s-1", false), tile("group-2", "s-2", false)], focused: "main", visible: true });
    expect(setUnread).not.toHaveBeenCalled();
  });

  it("marks a conversation whose tile was closed mid-turn", () => {
    const { rerender, setUnread } = harness({ tiles: [tile("main", "s-1", false), tile("group-2", "s-2", true)], focused: "main", visible: true });
    rerender({ tiles: [tile("main", "s-1", false)], focused: "main", visible: true });
    expect(setUnread).toHaveBeenLastCalledWith("s-2", true);
  });

  it("leaves a conversation marked by hand alone until the user looks away and back", () => {
    const tiles = [tile("main", "s-1", false)];
    const { rerender, setUnread, unread } = harness({ tiles, focused: "main", visible: true });
    // The user marks the conversation in front of them unread. Nothing about
    // where they are looking changed, so nothing reads it back.
    unread.add("s-1");
    rerender({ tiles, focused: "main", visible: true });
    expect(setUnread).not.toHaveBeenCalled();
    // Looking away and back reads it.
    rerender({ tiles, focused: "main", visible: false });
    rerender({ tiles, focused: "main", visible: true });
    expect(setUnread).toHaveBeenLastCalledWith("s-1", false);
  });
});
