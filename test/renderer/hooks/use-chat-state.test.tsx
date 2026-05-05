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

  it("guidance_reset reopens the latest assistant entry instead of appending a new one", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "text_delta", text: "hello", streamId: 1 });
      emitChatStream({ type: "assistant_round", text: "hello", streamId: 1 });
      emitChatStream({ type: "done", streamId: 1 });
      emitChatStream({ type: "guidance_reset", streamId: 2 });
    });

    await waitFor(() => {
      const assistants = result.current.entries.filter((e) => e.kind === "assistant") as Array<{ text: string; streaming?: boolean }>;
      expect(assistants).toHaveLength(1);
      expect(assistants[0].text).toBe("hello");
      expect(assistants[0].streaming).toBe(true);
    });

    act(() => {
      emitChatStream({ type: "text_delta", text: " world", streamId: 2 });
    });

    await waitFor(() => {
      const assistants = result.current.entries.filter((e) => e.kind === "assistant") as Array<{ text: string; streaming?: boolean }>;
      expect(assistants).toHaveLength(1);
      expect(assistants[0].text).toBe("hello world");
      expect(assistants[0].streaming).toBe(true);
    });
  });

  it("ignores stale stream events after guidance_reset switches to a new stream id", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "text_delta", text: "hello", streamId: 1 });
      emitChatStream({ type: "assistant_round", text: "hello", streamId: 1 });
      emitChatStream({ type: "done", streamId: 1 });
      emitChatStream({ type: "guidance_reset", streamId: 2 });
    });

    await waitFor(() => {
      const assistant = result.current.entries.findLast((e) => e.kind === "assistant") as { text: string; streaming?: boolean };
      expect(assistant.text).toBe("hello");
      expect(assistant.streaming).toBe(true);
    });

    act(() => {
      emitChatStream({ type: "text_delta", text: " stale", streamId: 1 });
      emitChatStream({ type: "text_delta", text: " world", streamId: 2 });
    });

    await waitFor(() => {
      const assistant = result.current.entries.findLast((e) => e.kind === "assistant") as { text: string };
      expect(assistant.text).toBe("hello world");
    });
  });

  it("ignores late done and error events from the abandoned stream after guidance_reset", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      emitChatStream({ type: "text_delta", text: "hello", streamId: 1 });
      emitChatStream({ type: "assistant_round", text: "hello", streamId: 1 });
      emitChatStream({ type: "done", streamId: 1 });
      emitChatStream({ type: "guidance_reset", streamId: 2 });
    });

    await waitFor(() => {
      const assistant = result.current.entries.findLast((e) => e.kind === "assistant") as { text: string };
      expect(assistant.text).toBe("hello");
    });

    act(() => {
      emitChatStream({ type: "text_delta", text: " world", streamId: 2 });
    });

    await waitFor(() => {
      const assistant = result.current.entries.findLast((e) => e.kind === "assistant") as { text: string };
      expect(assistant.text).toBe("hello world");
    });

    act(() => {
      emitChatStream({ type: "error", error: "stale failure", streamId: 1 });
      emitChatStream({ type: "done", streamId: 1 });
    });

    await waitFor(() => {
      const assistant = result.current.entries.findLast((e) => e.kind === "assistant") as { text: string };
      expect(assistant.text).toBe("hello world");
      expect(result.current.entries.some((e) => e.kind === "assistant" && "text" in e && String(e.text).includes("오류: stale failure"))).toBe(false);
    });
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

  it("usedTokens grows monotonically with entries", () => {
    const small: ChatEntry[] = [{ kind: "user", text: "hi" }];
    const big: ChatEntry[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "a".repeat(1000) },
    ];
    const a = renderHook(() =>
      useContextBudget({ entries: small, llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    ).result.current.usedTokens;
    const b = renderHook(() =>
      useContextBudget({ entries: big, llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    ).result.current.usedTokens;
    expect(b).toBeGreaterThan(a);
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
    api.chatGetHistory.mockClear();
    api.chatGetHistory.mockResolvedValueOnce({
      sessionId: "other-sess",
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
