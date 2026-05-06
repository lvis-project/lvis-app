import "../../../../../test/renderer/setup.js";
import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LvisApi } from "../../types.js";
import { useContinuousHistory } from "../use-continuous-history.js";

function makeApi(customSessions?: Array<{ id: string; modifiedAt: string; title: string }>): LvisApi {
  const sessions = customSessions ?? [
    { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
    { id: "old-2", modifiedAt: "2026-05-05T08:00:00.000Z", title: "어제" },
    { id: "old-1", modifiedAt: "2026-05-04T08:00:00.000Z", title: "그제" },
  ];
  return {
    chatSessions: vi.fn(async (opts?: { limit?: number; before?: string; beforeId?: string; after?: string }) => {
      const beforeTime = opts?.before ? Date.parse(opts.before) : Number.NaN;
      const afterTime = opts?.after ? Date.parse(opts.after) : Number.NaN;
      const filtered = sessions.filter((session) => {
        const sessionTime = Date.parse(session.modifiedAt);
        if (!Number.isNaN(afterTime) && sessionTime < afterTime) return false;
        if (Number.isNaN(beforeTime)) return true;
        return sessionTime < beforeTime || (sessionTime === beforeTime && Boolean(opts?.beforeId) && session.id < opts.beforeId);
      });
      return { current: "current", sessions: filtered.slice(0, opts?.limit ?? filtered.length) };
    }),
    chatSessionHistory: vi.fn(async (sessionId: string) => ({
      ok: true,
      preambleChars: sessionId === "old-2" ? 17 : 0,
      parentSessionId: sessionId === "old-2" ? "parent-1" : undefined,
      messages: [
        { index: 0, role: "user", content: `${sessionId} 질문` },
        { index: 1, role: "assistant", content: `${sessionId} 답변` },
      ],
    })),
  } as unknown as LvisApi;
}

describe("useContinuousHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-06T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initially hydrates only the previous KST day and excludes current", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.map((session) => session.id)).toEqual(["old-2"]);
    });

    expect(api.chatSessions).toHaveBeenCalledWith({
      limit: 20,
      before: "2026-05-05T15:00:00.000Z",
      after: "2026-05-04T15:00:00.000Z",
    });
    expect(result.current.historicalSessions[0]?.entries[0]).toMatchObject({
      kind: "session_resume",
      preambleChars: 17,
    });
  });

  it("starts from the active session cursor when an anchor is provided", async () => {
    const api = makeApi([
      { id: "newer", modifiedAt: "2026-05-07T08:00:00.000Z", title: "더 최신" },
      { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
      { id: "old-2", modifiedAt: "2026-05-05T08:00:00.000Z", title: "어제" },
      { id: "old-1", modifiedAt: "2026-05-04T08:00:00.000Z", title: "그제" },
    ]);
    const { result } = renderHook(() =>
      useContinuousHistory(api, "current", true, {
        id: "current",
        modifiedAt: "2026-05-06T08:00:00.000Z",
      }),
    );

    await waitFor(() => {
      expect(result.current.historicalSessions.map((session) => session.id)).toEqual(["old-2"]);
    });

    expect(api.chatSessions).toHaveBeenCalledWith({
      limit: 20,
      before: "2026-05-05T15:00:00.000Z",
      after: "2026-05-04T15:00:00.000Z",
    });
  });

  it("loads the previous calendar day when loadMore reaches the top again", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.map((session) => session.id)).toEqual(["old-2"]);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.historicalSessions.map((session) => session.id)).toEqual(["old-1", "old-2"]);
    expect(api.chatSessions).toHaveBeenLastCalledWith({
      limit: 20,
      before: "2026-05-04T15:00:00.000Z",
      after: "2026-05-03T15:00:00.000Z",
    });
  });

  it("uses the oldest loaded session as a within-day cursor before advancing days", async () => {
    const manySessions = [
      { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
      ...Array.from({ length: 21 }, (_, idx) => ({
        id: `yesterday-${idx}`,
        modifiedAt: new Date(Date.UTC(2026, 4, 5, 8, idx, 0)).toISOString(),
        title: `어제 ${idx}`,
      })).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)),
    ];
    const api = makeApi(manySessions);
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.length).toBe(20);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.historicalSessions.length).toBe(21);
    expect(api.chatSessions).toHaveBeenLastCalledWith({
      limit: 20,
      before: "2026-05-05T08:01:00.000Z",
      beforeId: "yesterday-1",
      after: "2026-05-04T15:00:00.000Z",
    });
  });

  it("uses session id as a tiebreaker when timestamps match the next cursor", async () => {
    const sameTime = "2026-05-01T08:00:00.000Z";
    const sessions = [
      { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
      ...Array.from({ length: 21 }, (_, idx) => ({
        id: `old-${String(30 - idx).padStart(2, "0")}`,
        modifiedAt: sameTime,
        title: `이전 ${idx}`,
      })),
    ];
    const api = makeApi(sessions);
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.length).toBe(20);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(api.chatSessions).toHaveBeenLastCalledWith({
      limit: 20,
      before: sameTime,
      beforeId: "old-11",
      after: "2026-04-30T15:00:00.000Z",
    });
    await waitFor(() => {
      expect(result.current.historicalSessions.map((session) => session.id)).toContain("old-10");
      expect(result.current.historicalSessions.length).toBe(21);
    });
  });

  it("ignores a stale loadMore response after the active session changes", async () => {
    let resolveSessions: ((value: { current: string; sessions: Array<{ id: string; modifiedAt: string; title: string }> }) => void) | undefined;
    const api = makeApi();
    vi.mocked(api.chatSessions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSessions = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ currentSessionId }) => useContinuousHistory(api, currentSessionId, true),
      { initialProps: { currentSessionId: "current" } },
    );

    await act(async () => {
      const promise = result.current.loadMore();
      rerender({ currentSessionId: "new-current" });
      resolveSessions?.({
        current: "current",
        sessions: [{ id: "stale-old", modifiedAt: "2026-05-05T08:00:00.000Z", title: "stale" }],
      });
      await promise;
    });

    expect(result.current.historicalSessions.some((session) => session.id === "stale-old")).toBe(false);
  });

  it("jumps directly to the next older day with sessions instead of scanning day-by-day", async () => {
    const api = makeApi([
      { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
      { id: "ancient", modifiedAt: "2020-01-01T08:00:00.000Z", title: "오래된 대화" },
    ]);

    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.map((session) => session.id)).toEqual(["ancient"]);
    });
    expect(result.current.reachedEnd).toBe(false);
    expect(api.chatSessions).toHaveBeenCalledTimes(3);
    expect(api.chatSessions).toHaveBeenNthCalledWith(2, {
      limit: 1,
      before: "2026-05-04T15:00:00.000Z",
    });
    expect(api.chatSessions).toHaveBeenNthCalledWith(3, {
      limit: 20,
      before: "2020-01-01T15:00:00.000Z",
      after: "2019-12-31T15:00:00.000Z",
    });
  });

  it("marks history exhausted when no older session exists", async () => {
    const api = makeApi([
      { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
    ]);
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.reachedEnd).toBe(true);
    });
    expect(result.current.historicalSessions).toEqual([]);
  });
});
