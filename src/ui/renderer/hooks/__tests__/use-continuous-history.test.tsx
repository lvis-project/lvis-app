import "../../../../../test/renderer/setup.js";
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LvisApi } from "../../types.js";
import { useContinuousHistory } from "../use-continuous-history.js";

function makeApi(customSessions?: Array<{ id: string; modifiedAt: string; title: string }>): LvisApi {
  const sessions = customSessions ?? [
    { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
    { id: "old-2", modifiedAt: "2026-05-05T08:00:00.000Z", title: "어제" },
    { id: "old-1", modifiedAt: "2026-05-04T08:00:00.000Z", title: "그제" },
  ];
  return {
    chatSessions: vi.fn(async (opts?: { limit?: number; before?: string; beforeId?: string }) => {
      const beforeTime = opts?.before ? Date.parse(opts.before) : Number.NaN;
      const filtered = sessions.filter((session) => {
        if (Number.isNaN(beforeTime)) return true;
        const sessionTime = Date.parse(session.modifiedAt);
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
  it("loads persisted sessions above the active session and excludes current", async () => {
    const api = makeApi();
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.map((session) => session.id)).toEqual(["old-1", "old-2"]);
    });

    expect(api.chatSessions).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    expect(result.current.historicalSessions[1]?.entries[0]).toMatchObject({
      kind: "session_resume",
      preambleChars: 17,
    });
  });

  it("uses the oldest loaded session timestamp as the next cursor", async () => {
    const manySessions = Array.from({ length: 21 }, (_, idx) => {
      const date = new Date(Date.UTC(2026, 4, 6 - idx, 8, 0, 0));
      return {
        id: idx === 0 ? "current" : `old-${idx}`,
        modifiedAt: date.toISOString(),
        title: idx === 0 ? "현재" : `이전 ${idx}`,
      };
    });
    const api = makeApi(manySessions);
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.length).toBe(19);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(api.chatSessions).toHaveBeenLastCalledWith({
      limit: 20,
      before: "2026-04-17T08:00:00.000Z",
      beforeId: "old-19",
    });
  });

  it("uses session id as a tiebreaker when timestamps match the next cursor", async () => {
    const sameTime = "2026-05-01T08:00:00.000Z";
    const sessions = [
      { id: "current", modifiedAt: "2026-05-06T08:00:00.000Z", title: "현재" },
      ...Array.from({ length: 19 }, (_, idx) => ({
        id: `old-${String(30 - idx).padStart(2, "0")}`,
        modifiedAt: sameTime,
        title: `이전 ${idx}`,
      })),
      { id: "old-10", modifiedAt: sameTime, title: "동시간대 다음 페이지" },
    ];
    const api = makeApi(sessions);
    const { result } = renderHook(() => useContinuousHistory(api, "current", true));

    await waitFor(() => {
      expect(result.current.historicalSessions.length).toBe(19);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(api.chatSessions).toHaveBeenLastCalledWith({
      limit: 20,
      before: sameTime,
      beforeId: "old-12",
    });
    await waitFor(() => {
      expect(result.current.historicalSessions.map((session) => session.id)).toContain("old-10");
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
});
