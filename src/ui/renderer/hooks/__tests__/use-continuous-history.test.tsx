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
    chatSessions: vi.fn(async (opts?: { limit?: number; before?: string }) => {
      const beforeTime = opts?.before ? Date.parse(opts.before) : Number.NaN;
      const filtered = sessions.filter((session) => Number.isNaN(beforeTime) || Date.parse(session.modifiedAt) < beforeTime);
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

    expect(api.chatSessions).toHaveBeenCalledWith({ limit: 20, before: undefined });
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
    });
  });
});
