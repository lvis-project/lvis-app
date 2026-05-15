/**
 * Phase 5 hook tests — use-chat-state + sibling hooks.
 *
 * Fix 2 (PR #98): Unit tests for the domain hooks extracted from App.tsx.
 * Focuses on the pieces most at risk of regressing:
 *   - use-chat-state subscribes on mount, unsubs on unmount, no double-subscribe
 *   - use-context-budget arithmetic is deterministic
 *   - use-cost-estimate memo invariants
 *   - use-sessions streaming guard on load
 *   - use-starred toggle semantics
 */
import "../setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeMockLvisApi } from "../mock-lvis-api.js";
import { useChatState } from "../../../src/ui/renderer/hooks/use-chat-state.js";
import { useContextBudget } from "../../../src/ui/renderer/hooks/use-context-budget.js";
import { useCostEstimate } from "../../../src/ui/renderer/hooks/use-cost-estimate.js";
import { useSessions } from "../../../src/ui/renderer/hooks/use-sessions.js";
import { useStarred } from "../../../src/ui/renderer/hooks/use-starred.js";
import type { LvisApi } from "../../../src/ui/renderer/types.js";
import type { ChatEntry } from "../../../src/lib/chat-stream-state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useChatState", () => {
  it("subscribes to onChatStream on mount", () => {
    const { api } = makeMockLvisApi();
    renderHook(() => useChatState(api as unknown as LvisApi));
    expect(api.onChatStream).toHaveBeenCalledTimes(1);
  });

  it("updates entries when a text_delta event is emitted", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "text_delta", text: "hello world" });
    });

    await waitFor(() => {
      const hasAssistant = result.current.entries.some(
        (e) => e.kind === "assistant" && (e as { text: string }).text.includes("hello world"),
      );
      expect(hasAssistant).toBe(true);
    });
  });

  it("keeps overlay-import responses in the normal assistant stream", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      result.current.insertImportedTriggerEntry({
        sessionId: "trigger-1",
        pluginId: "meeting",
        prompt: "<imported-from-overlay source=\"overlay:meeting-summary\">요약</imported-from-overlay>",
        summary: "회의 요약",
        title: "회의",
      });
      emitChatStream({ type: "text_delta", text: "assistant reply" });
    });

    await waitFor(() => {
      const imported = result.current.entries.find((e) => e.kind === "imported_trigger");
      const assistant = result.current.entries.find((e) => e.kind === "assistant");
      expect(imported).toMatchObject({ kind: "imported_trigger", sessionId: "trigger-1" });
      expect(Object.keys(imported ?? {}).sort()).toEqual([
        "importedAt",
        "kind",
        "prompt",
        "sessionId",
        "source",
        "summary",
        "toolCallCount",
      ]);
      expect(assistant).toMatchObject({
        kind: "assistant",
        text: "assistant reply",
        streaming: true,
      });
    });
  });

  it("dispatches a permission badge refresh event when slash mode changes", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const listener = vi.fn();
    window.addEventListener("lvis:permissions:mode-changed", listener);
    renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "permission_mode_changed", mode: "allow" });
    });

    await waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1);
    });
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: { mode: "allow" } });
    window.removeEventListener("lvis:permissions:mode-changed", listener);
  });

  it("splices marker-only assistant rounds when no tool/checkpoint sibling exists (#619)", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "text_delta", text: "<title>제목</title>[checkpoint]" });
      emitChatStream({
        type: "assistant_round",
        text: "<title>제목</title>[checkpoint]",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
    });

    await waitFor(() => {
      const assistant = result.current.entries.findLast((e) => e.kind === "assistant");
      expect(assistant).toBeUndefined();
    });
  });

  it("splices marker-only done events when no tool/checkpoint sibling exists (#619)", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "text_delta", text: "<title>제목</title>[checkpoint]" });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      const assistant = result.current.entries.findLast((e) => e.kind === "assistant");
      expect(assistant).toBeUndefined();
    });
  });

  it("preserves checkpoint summary from compact_notice events", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({
        type: "compact_notice",
        removedMessages: 7,
        freedTokens: 123,
        tier: "auto-compact",
        summary: "이전 주제 요약",
      });
    });

    // Since 5b19e05c, compact_notice with freedTokens > 0 also emits a
    // synthetic `context_usage` carrier after the checkpoint so the ring
    // refreshes. The intent of this test is the checkpoint payload — not
    // its position — so locate it by kind.
    await waitFor(() => {
      const checkpoint = result.current.entries.findLast((e) => e.kind === "checkpoint");
      expect(checkpoint).toMatchObject({
        kind: "checkpoint",
        removedMessages: 7,
        freedTokens: 123,
        tier: "auto-compact",
        summary: "이전 주제 요약",
      });
    });
  });

  it("does not log to console when VITE_DEBUG_STREAM is unset (Fix 3)", () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    renderHook(() => useChatState(api as unknown as LvisApi));
    act(() => {
      emitChatStream({ type: "text_delta", text: "x" });
    });
    const streamLogs = spy.mock.calls.filter((c) => c[0] === "[lvis:chat:stream]");
    expect(streamLogs.length).toBe(0);
    spy.mockRestore();
  });

  it("unsubscribes the chat stream listener on unmount", () => {
    const { api } = makeMockLvisApi();
    const unsubscribe = vi.fn();
    api.onChatStream.mockImplementationOnce(() => unsubscribe);
    const { unmount } = renderHook(() => useChatState(api as unknown as LvisApi));

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not warn about setState after unmount (aliveRef)", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(() => useChatState(api as unknown as LvisApi));

    unmount();
    // Emit after unmount — aliveRef should swallow it with no setState.
    act(() => {
      emitChatStream({ type: "text_delta", text: "late" });
      emitChatStream({ type: "reasoning_delta", text: "late" });
      emitChatStream({ type: "done" });
    });

    const unmountWarnings = errSpy.mock.calls.filter((c) =>
      String(c[0] ?? "").includes("unmounted"),
    );
    expect(unmountWarnings.length).toBe(0);
    errSpy.mockRestore();
  });

  it("guidance_injected appends a user bubble with injectHint='queue' without disturbing streaming assistant", async () => {
    // 사용자 피드백 (2026-05-15): system entry ("방향 지시 적용:") 대신 일반
    // user bubble + injectHint="queue" 배지. mid-turn brake-point 의 큐 인입은
    // 사용자 입력 누적의 자동 발화이므로 user kind 가 mental model 정합.
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "text_delta", text: "hello", streamId: 1 });
    });
    act(() => {
      emitChatStream({ type: "guidance_injected", text: "더 짧게", streamId: 1 });
    });

    await waitFor(() => {
      const userEntries = result.current.entries.filter((e) => e.kind === "user") as Array<{ text: string; injectHint?: "queue" | "interrupt" }>;
      expect(userEntries.some((e) => e.text === "더 짧게" && e.injectHint === "queue")).toBe(true);
    });
    // Streaming assistant entry is preserved — guide is non-interrupting.
    const assistants = result.current.entries.filter((e) => e.kind === "assistant") as Array<{ text: string; streaming?: boolean }>;
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe("hello");
    expect(assistants[0].streaming).toBe(true);
  });

  it("guidance_injected with empty text is a no-op (defense-in-depth)", () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "guidance_injected", text: "", streamId: 1 });
    });

    expect(result.current.entries.filter((e) => e.kind === "system")).toHaveLength(0);
  });

  it("rerender does not create an extra subscription on the same instance", () => {
    const { api } = makeMockLvisApi();
    const { rerender } = renderHook(() => useChatState(api as unknown as LvisApi));
    rerender();
    rerender();
    // Same api reference → effect deps unchanged → subscription stays the same one.
    expect(api.onChatStream).toHaveBeenCalledTimes(1);
  });
});

describe("useContextBudget (deterministic math)", () => {
  it("returns zero usedTokens for empty entries", () => {
    const { result } = renderHook(() =>
      useContextBudget({ entries: [], llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    );
    expect(result.current.usedTokens).toBe(0);
    expect(result.current.isOverflow).toBe(false);
  });

  it("usedTokens reflects the latest turn_summary's tokensIn", () => {
    // 2026-05-07 Phase 3: usedTokens 는 더 이상 entries 의 chars/4 누적이
    // 아니라 *마지막 turn_summary entry 의 tokensIn* (provider report). 같은
    // turn 안에서 모델 호출 후 turn_summary 가 emit 되면 그 값으로 ring 이
    // 갱신, compact 후 다음 turn 에는 작은 값이 들어와 자동 감소. 이전
    // monotonic-growth contract 는 더 이상 보장되지 않으며 (compact 가
    // 의도적으로 줄임), 이 테스트가 새 contract 를 명시적으로 검증.
    const after10k: ChatEntry[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "answer" },
      {
        kind: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 10_000,
        tokensOut: 200,
      },
    ];
    const after5k: ChatEntry[] = [
      ...after10k,
      { kind: "user", text: "more" },
      { kind: "assistant", text: "post-compact" },
      {
        kind: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 5_000,
        tokensOut: 100,
      },
    ];
    const a = renderHook(() =>
      useContextBudget({ entries: after10k, llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    ).result.current.usedTokens;
    const b = renderHook(() =>
      useContextBudget({ entries: after5k, llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    ).result.current.usedTokens;
    expect(a).toBe(10_000);
    expect(b).toBe(5_000); // compact 후 감소가 정상 — Phase 3 의 핵심 동작.
  });

  it("usedTokens reflects a loaded session context estimate until a live turn summary arrives", () => {
    const loaded: ChatEntry[] = [
      { kind: "user", text: "이전 질문" },
      { kind: "assistant", text: "이전 답변", streaming: false },
      { kind: "context_usage", tokensIn: 12_345, source: "session-estimate" },
    ];
    const liveAfterLoaded: ChatEntry[] = [
      ...loaded,
      { kind: "user", text: "새 질문" },
      { kind: "assistant", text: "새 답변" },
      {
        kind: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 6_789,
        freshInputTokens: 6_789,
        tokensOut: 100,
      },
    ];

    const a = renderHook(() =>
      useContextBudget({ entries: loaded, llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    ).result.current.usedTokens;
    const b = renderHook(() =>
      useContextBudget({ entries: liveAfterLoaded, llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    ).result.current.usedTokens;

    expect(a).toBe(12_345);
    expect(b).toBe(6_789);
  });
});

describe("useCostEstimate (memo invariants)", () => {
  it("returns a cost object with a badge class", () => {
    const { result } = renderHook(() =>
      useCostEstimate({
        entries: [],
        question: "hello",
        llmVendor: "openai",
        llmModel: "gpt-4o-mini",
        maxOutputTokens: 1024,
        composeOutgoing: (raw: string) => raw,
      }),
    );
    expect(result.current.costEstimate).toBeDefined();
    expect(typeof result.current.costBadgeClass).toBe("string");
    expect(result.current.costEstimate.total).toBeGreaterThanOrEqual(0);
  });
});

describe("useSessions (streaming guard)", () => {
  it("handleLoadSession is a no-op while streaming=true", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useSessions(api as unknown as LvisApi));
    const setEntries = vi.fn();
    await act(async () => {
      await result.current.handleLoadSession("other-sess", true, setEntries);
    });
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    expect(setEntries).not.toHaveBeenCalled();
  });

  it("handleLoadSession loads when not streaming", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useSessions(api as unknown as LvisApi));
    const setEntries = vi.fn();
    await act(async () => {
      await result.current.handleLoadSession("other-sess", false, setEntries);
    });
    expect(api.chatSessionResume).toHaveBeenCalledWith("other-sess");
    expect(setEntries).toHaveBeenCalled();
  });

  it("handleLoadSession replays structural history into chat entries", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useSessions(api as unknown as LvisApi));
    const setEntries = vi.fn();
    api.chatSessionHistory.mockClear();
    api.chatSessionHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        { index: 0, role: "user", content: "작업 순서 확인" },
        {
          index: 1,
          role: "assistant",
          content: "",
          thought: "검색 계획",
          toolCalls: [{ id: "t1", name: "web_search", input: { q: "LVIS" } }],
        },
        { index: 2, role: "tool_result", toolUseId: "t1", toolName: "web_search", content: "검색 결과" },
        { index: 3, role: "assistant", content: "중간 답변" },
        {
          index: 4,
          role: "assistant",
          content: "",
          thought: "검증 계획",
          toolCalls: [{ id: "t2", name: "web_fetch", input: { url: "https://example.com" } }],
        },
        { index: 5, role: "tool_result", toolUseId: "t2", toolName: "web_fetch", content: "본문" },
        { index: 6, role: "assistant", content: "최종 답변" },
      ],
    });

    await act(async () => {
      await result.current.handleLoadSession("other-sess", false, setEntries);
    });

    expect(api.chatSessionHistory).toHaveBeenCalledWith("other-sess");

    expect(setEntries).toHaveBeenCalledWith([
      { kind: "user", text: "작업 순서 확인" },
      { kind: "reasoning", text: "검색 계획", streaming: false },
      expect.objectContaining({ kind: "tool_group", status: "done" }),
      { kind: "assistant", text: "중간 답변", streaming: false, route: undefined },
      { kind: "reasoning", text: "검증 계획", streaming: false },
      expect.objectContaining({ kind: "tool_group", status: "done" }),
      { kind: "assistant", text: "최종 답변", streaming: false, route: undefined },
    ]);
    expect(result.current.currentSessionId).toBe("other-sess");
  });

  it("handleLoadSession carries the persisted session context token estimate", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useSessions(api as unknown as LvisApi));
    const setEntries = vi.fn();
    api.chatSessionHistory.mockClear();
    api.chatSessionHistory.mockResolvedValueOnce({
      ok: true,
      estimatedInputTokens: 4321,
      messages: [
        { index: 0, role: "user", content: "이전 질문" },
        { index: 1, role: "assistant", content: "이전 답변" },
      ],
    });

    await act(async () => {
      await result.current.handleLoadSession("other-sess", false, setEntries);
    });

    expect(setEntries).toHaveBeenCalledWith([
      { kind: "user", text: "이전 질문" },
      { kind: "assistant", text: "이전 답변", streaming: false, route: undefined },
      { kind: "context_usage", tokensIn: 4321, source: "session-estimate" },
    ]);
  });

  it("handleLoadSession cancels a late startup hydrate before it can overwrite the loaded session", async () => {
    const { api } = makeMockLvisApi();
    const startupHistory = deferred<{ sessionId: string; messages: unknown[] }>();
    api.chatGetHistory.mockReset();
    api.chatSessionHistory.mockReset();
    api.chatGetHistory
      .mockReturnValueOnce(startupHistory.promise);
    api.chatSessionHistory
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ index: 0, role: "user", content: "manual session" }],
      });
    const applyInitial = vi.fn();
    const applyLoaded = vi.fn();
    const { result } = renderHook(() =>
      useSessions(api as unknown as LvisApi, applyInitial),
    );

    await waitFor(() => expect(api.chatGetHistory).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.handleLoadSession("manual-sess", false, applyLoaded);
    });

    expect(applyLoaded).toHaveBeenCalledWith([{ kind: "user", text: "manual session" }]);
    expect(result.current.currentSessionId).toBe("manual-sess");

    await act(async () => {
      startupHistory.resolve({
        sessionId: "startup-sess",
        messages: [{ index: 0, role: "user", content: "stale startup" }],
      });
      await startupHistory.promise;
    });

    expect(applyInitial).not.toHaveBeenCalled();
    expect(result.current.currentSessionId).toBe("manual-sess");
  });

  it("hydrates the latest persisted session on startup when active loop is empty", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "fresh-empty",
      history: { sessionId: "fresh-empty", messages: [] },
      sessions: [{ id: "persisted-sess", modifiedAt: new Date().toISOString(), title: "Persisted" }],
    });
    api.chatSessionHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        { index: 0, role: "user", content: "이전 질문" },
        { index: 1, role: "assistant", content: "이전 답변" },
      ],
    });
    const applyInitial = vi.fn();

    const { result } = renderHook(() =>
      useSessions(api as unknown as LvisApi, applyInitial),
    );

    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith("persisted-sess"));
    await waitFor(() => {
      expect(applyInitial).toHaveBeenCalledWith([
        { kind: "user", text: "이전 질문" },
        { kind: "assistant", text: "이전 답변", streaming: false, route: undefined },
      ]);
    });
    expect(result.current.currentSessionId).toBe("persisted-sess");
  });

  it("hydrates active in-memory history with its context token estimate", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "active-sess",
      history: {
        sessionId: "active-sess",
        estimatedInputTokens: 2468,
        messages: [
          { index: 0, role: "user", content: "진행 중 질문" },
          { index: 1, role: "assistant", content: "진행 중 답변" },
        ],
      },
    });
    const applyInitial = vi.fn();

    renderHook(() => useSessions(api as unknown as LvisApi, applyInitial));

    await waitFor(() => {
      expect(applyInitial).toHaveBeenCalledWith([
        { kind: "user", text: "진행 중 질문" },
        { kind: "assistant", text: "진행 중 답변", streaming: false, route: undefined },
        { kind: "context_usage", tokensIn: 2468, source: "session-estimate" },
      ]);
    });
  });

  it("hydrates today's latest persisted session on startup when active loop is empty", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
      const { api } = makeMockLvisApi({
        currentSession: "fresh-empty",
        history: { sessionId: "fresh-empty", messages: [] },
        sessions: [
          { id: "today-early", modifiedAt: "2026-05-10T23:00:00.000Z", title: "Today early" },
          { id: "yesterday-late", modifiedAt: "2026-05-10T14:59:59.000Z", title: "Yesterday late" },
          { id: "today-late", modifiedAt: "2026-05-11T02:30:00.000Z", title: "Today late" },
        ],
      });
      api.chatSessionHistory.mockResolvedValueOnce({
        ok: true,
        messages: [
          { index: 0, role: "user", content: "오늘 마지막 질문" },
          { index: 1, role: "assistant", content: "오늘 마지막 답변" },
        ],
      });
      const applyInitial = vi.fn();

      const { result } = renderHook(() =>
        useSessions(api as unknown as LvisApi, applyInitial),
      );

      await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith("today-late"));
      expect(api.chatSessionResume).not.toHaveBeenCalledWith("yesterday-late");
      expect(result.current.currentSessionId).toBe("today-late");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume a prior-day session on startup when today has no persisted session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-05-11T03:00:00.000Z"));
      const { api } = makeMockLvisApi({
        currentSession: "fresh-empty",
        history: { sessionId: "fresh-empty", messages: [] },
        sessions: [
          { id: "yesterday-late", modifiedAt: "2026-05-10T14:59:59.000Z", title: "Yesterday late" },
        ],
      });
      const applyInitial = vi.fn();

      const { result } = renderHook(() =>
        useSessions(api as unknown as LvisApi, applyInitial),
      );

      await waitFor(() => expect(api.chatSessions).toHaveBeenCalled());
      expect(api.chatSessionResume).not.toHaveBeenCalled();
      expect(applyInitial).toHaveBeenCalledWith([]);
      expect(result.current.currentSessionId).toBe("fresh-empty");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useStarred (toggle semantics)", () => {
  it("toggles: addStarred when not starred, removeStarred when already starred", async () => {
    const { api } = makeMockLvisApi({
      starred: [
        {
          id: "star-1",
          sessionId: "sess-a",
          messageIndex: 0,
          role: "user",
          text: "hi",
          starredAt: new Date().toISOString(),
        },
      ],
    });
    const { result } = renderHook(() => useStarred(api as unknown as LvisApi));
    await waitFor(() => expect(api.starredList).toHaveBeenCalled());
    await waitFor(() => expect(result.current.starred.length).toBe(1));

    const entries: ChatEntry[] = [
      { kind: "user", text: "hi" },
      { kind: "user", text: "next" },
    ];
    const idxMap = new Map<number, number>([[0, 0], [1, 1]]);

    // entry 0 is already starred → remove path.
    await act(async () => {
      await result.current.handleToggleStar(0, entries, "sess-a", idxMap);
    });
    expect(api.starredRemove).toHaveBeenCalledWith({ id: "star-1" });

    // entry 1 is not starred → add path.
    await act(async () => {
      await result.current.handleToggleStar(1, entries, "sess-a", idxMap);
    });
    expect(api.starredAdd).toHaveBeenCalled();
  });
});
