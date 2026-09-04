import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TileSession } from "../../components/chat-group-session-registry.js";
import { turnsEnded, turnsEndedUnseen, useCurrentSession, useTurnAttention } from "../use-sessions.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import type { LvisApi } from "../../types.js";

const tile = (chatGroupId: string, sessionId: string, streaming: boolean): TileSession =>
  ({ chatGroupId, sessionId, streaming, hidden: false, paneHidden: false, askQuestions: [] });

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

describe("useCurrentSession — what a tile holds on mount", () => {
  const resumeState = {
    mainActiveSessionId: "main-active",
    mainActiveMode: "resume" as const,
    updatedAt: new Date().toISOString(),
  };

  it("the primary tile resumes the window's main-active conversation", async () => {
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-fresh", messages: [] },
      historyBySession: { "main-active": { messages: [{ role: "user", content: "hi" }] } },
    });
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));
    await waitFor(() => expect(result.current.currentSessionId).toBe("main-active"));
    expect(api.chatSessionResume).toHaveBeenCalledWith("main-active");
  });

  it("the primary tile keeps the conversation its loop holds even when the window's main-active pointer names another", async () => {
    // A routine session is never the main-active pointer; a folded primary
    // brought forward for it must show it, not the pointer's session.
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "routine-held", sessionKind: "routine", messages: [{ role: "user", content: "held" }] },
      historyBySession: { "main-active": { messages: [{ role: "user", content: "hi" }] } },
    });
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));
    await waitFor(() => expect(result.current.currentSessionId).toBe("routine-held"));
    expect(result.current.currentSessionKind).toBe("routine");
    expect(api.chatSessionResume).not.toHaveBeenCalled();
  });

  it("a tile under a project creates its fresh conversation there, so the sidebar files it with the project", async () => {
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-fresh", messages: [] },
    });
    const project = { projectRoot: "/work/lvis", projectName: "lvis" };
    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { resumeWindowActiveSession: false, freshProject: project }));
    await waitFor(() => expect(api.chatNew).toHaveBeenCalledWith(project));
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-fresh"));
    expect(api.chatSessionResume).not.toHaveBeenCalled();
  });

  it("a change of the window's active project does not re-hydrate a tile that holds a conversation", async () => {
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-fresh", messages: [] },
    });
    const first = { projectRoot: "/work/a", projectName: "a" };
    const { result, rerender } = renderHook(
      ({ project }: { project: { projectRoot: string; projectName: string } }) =>
        useCurrentSession(api as unknown as LvisApi, { resumeWindowActiveSession: false, freshProject: project }),
      { initialProps: { project: first } },
    );
    await waitFor(() => expect(api.chatNew).toHaveBeenCalledTimes(1));
    rerender({ project: { projectRoot: "/work/b", projectName: "b" } });
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-fresh"));
    expect(api.chatNew).toHaveBeenCalledTimes(1);
  });

  it("a tile whose loop already holds a conversation keeps it on mount instead of starting over", async () => {
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-live", messages: [{ role: "user", content: "kept" }] },
    });
    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, {
        resumeWindowActiveSession: false,
        freshProject: { projectRoot: "/work/a", projectName: "a" },
      }));
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-live"));
    expect(api.chatNew).not.toHaveBeenCalled();
    expect(api.chatSessionResume).not.toHaveBeenCalled();
  });

  it("any other tile starts on its own loop's session and never touches the window's active state", async () => {
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-fresh", messages: [] },
      historyBySession: { "main-active": { messages: [{ role: "user", content: "hi" }] } },
    });
    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { resumeWindowActiveSession: false }));
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-fresh"));
    expect(api.chatMainActiveState).not.toHaveBeenCalled();
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    // No project to file it under: the loop's own empty session is the fresh state.
    expect(api.chatNew).not.toHaveBeenCalled();
  });

  it("an empty tile already filed under the requested project is the fresh state — re-hydration makes no new session", async () => {
    const project = { projectRoot: "/work/a", projectName: "a" };
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-fresh", messages: [], ...project },
    });
    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { resumeWindowActiveSession: false, freshProject: project }));
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-fresh"));
    expect(result.current.currentSessionProject).toMatchObject(project);
    expect(api.chatNew).not.toHaveBeenCalled();
  });

  it("a tile that keeps its loop's conversation also gets that conversation's sub-agent cards back", async () => {
    const restoredSubAgents = [{ agentId: "sub-1", status: "completed" }];
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-live", messages: [{ role: "user", content: "kept" }], restoredSubAgents },
    });
    const restoreSubAgents = vi.fn();
    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { resumeWindowActiveSession: false, restoreSubAgents }));
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-live"));
    expect(restoreSubAgents).toHaveBeenCalledWith(restoredSubAgents);
  });

  it("loading a conversation restores its sub-agent rows AFTER the reset for the new session, not before", async () => {
    const restoredSubAgents = [{ agentId: "sub-1", status: "completed" }];
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-live", messages: [] },
      historyBySession: { other: { messages: [{ role: "user", content: "x" }], restoredSubAgents } },
    });
    const order: string[] = [];
    const restoreSubAgents = vi.fn(() => { order.push("restore"); });
    const onLoadedSession = vi.fn(() => { order.push("reset"); });
    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { resumeWindowActiveSession: false, restoreSubAgents, onLoadedSession }));
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-live"));
    order.length = 0;
    await act(async () => { await result.current.handleLoadSession("other", vi.fn()); });
    expect(order).toEqual(["reset", "restore"]);
    expect(restoreSubAgents).toHaveBeenLastCalledWith(restoredSubAgents);
  });

  it("loading a conversation another group holds brings that group forward instead of failing silently", async () => {
    const { api } = makeMockLvisApi({
      mainActiveState: resumeState,
      history: { sessionId: "loop-fresh", messages: [] },
    });
    api.chatSessionResume.mockResolvedValue({
      ok: false, compacted: false, compactedAt: null, removedMessageCount: 0,
      error: "session-open-in-other-group", holderChatGroupId: "group-2",
    });
    const focusSessionHolder = vi.fn(() => true);
    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { resumeWindowActiveSession: false, focusSessionHolder }));
    await waitFor(() => expect(result.current.currentSessionId).toBe("loop-fresh"));

    const applyLoadedSession = vi.fn();
    const loaded = await result.current.handleLoadSession("held-elsewhere", applyLoadedSession);
    expect(loaded).toBe(true);
    expect(focusSessionHolder).toHaveBeenCalledWith("group-2");
    expect(api.chatSessionHistory).not.toHaveBeenCalledWith("held-elsewhere");
    expect(applyLoadedSession).not.toHaveBeenCalled();
    // This tile still shows what it held; the conversation is on the other tile.
    expect(result.current.currentSessionId).toBe("loop-fresh");
  });
});

describe("turn ends refresh the window's list, seen or not", () => {
  const tile = (chatGroupId: string, sessionId: string, streaming: boolean): TileSession =>
    ({ chatGroupId, sessionId, streaming, hidden: false, paneHidden: false, askQuestions: [] });

  it("turnsEnded names every conversation whose tile stopped streaming", () => {
    const before = [tile("main", "s-1", true), tile("group-2", "s-2", true), tile("group-3", "s-3", false)];
    const after = [tile("main", "s-1", false), tile("group-2", "s-2", true), tile("group-3", "s-3", false)];
    expect(turnsEnded(before, after)).toEqual(["s-1"]);
    // A tile that moved on mid-turn no longer speaks for the turn that ended.
    expect(turnsEnded(before, [tile("main", "s-9", false), tile("group-2", "s-2", true)])).toEqual([]);
  });

  it("reports the end of a turn the user watched, which is not marked unread", () => {
    const onTurnsEnded = vi.fn();
    const setUnread = vi.fn();
    const attention = { focusedChatGroupId: "group-2", conversationVisible: true };
    const { rerender } = renderHook(
      ({ tiles }: { tiles: TileSession[] }) =>
        useTurnAttention({ tiles, attention, isUnread: () => false, setUnread, onTurnsEnded }),
      { initialProps: { tiles: [tile("main", "s-1", false), tile("group-2", "s-2", true)] } },
    );
    rerender({ tiles: [tile("main", "s-1", false), tile("group-2", "s-2", false)] });
    expect(onTurnsEnded).toHaveBeenCalledWith(["s-2"]);
    expect(setUnread).not.toHaveBeenCalled();
  });
});
