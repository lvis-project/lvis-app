/**
 * Phase 5 hook tests — use-chat-state + sibling hooks.
 *
 * Unit tests for the domain hooks extracted from App.tsx.
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
import { deferred } from "../helpers.js";
import { useChatState } from "../../../src/ui/renderer/hooks/use-chat-state.js";
import { useContextBudget } from "../../../src/ui/renderer/hooks/use-context-budget.js";
import { useCostEstimate } from "../../../src/ui/renderer/hooks/use-cost-estimate.js";
import { useCurrentSession, useSessionList } from "../../../src/ui/renderer/hooks/use-sessions.js";
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

  it("keeps the permission review verdict once the matching tool runs", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      result.current.appendUserEntry("자동 승인 확인");
      result.current.setStreaming(true);
    });
    act(() => {
      emitChatStream({
        type: "permission_review",
        reviewStatus: "auto_approved",
        name: "safe_tool",
        groupId: "g-verdict",
        toolUseId: "t-verdict",
        verdictLevel: "low",
      });
    });

    expect(result.current.entries.some((entry) => entry.kind === "permission_review")).toBe(true);

    act(() => {
      emitChatStream({
        type: "tool_start",
        name: "safe_tool",
        groupId: "g-verdict",
        toolUseId: "t-verdict",
      });
    });
    expect(result.current.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "permission_review",
      "tool_group",
    ]);

    act(() => {
      emitChatStream({
        type: "tool_end",
        name: "safe_tool",
        groupId: "g-verdict",
        toolUseId: "t-verdict",
        result: "ok",
      });
    });
    act(() => {
      emitChatStream({ type: "done" });
    });
    expect(result.current.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "permission_review",
      "tool_group",
    ]);
  });

  it("keeps the verdict through a local error and drops it only with a new chat", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      result.current.appendUserEntry("초기 요청");
      emitChatStream({
        type: "permission_review",
        reviewStatus: "auto_approved",
        name: "safe_tool",
        groupId: "g-reset",
        toolUseId: "t-reset",
        verdictLevel: "low",
      });
      emitChatStream({
        type: "tool_start",
        name: "safe_tool",
        groupId: "g-reset",
        toolUseId: "t-reset",
      });
    });
    expect(result.current.entries.some((entry) => entry.kind === "permission_review")).toBe(true);

    act(() => {
      result.current.clearForNewChat();
    });
    expect(result.current.entries).toEqual([]);

    act(() => {
      result.current.appendUserEntry("오류 요청");
      emitChatStream({
        type: "permission_review",
        reviewStatus: "auto_approved",
        name: "safe_tool",
        groupId: "g-error",
        toolUseId: "t-error",
        verdictLevel: "low",
      });
      emitChatStream({
        type: "tool_start",
        name: "safe_tool",
        groupId: "g-error",
        toolUseId: "t-error",
      });
    });

    act(() => {
      result.current.setErrorWithThought("local send failed");
    });
    expect(result.current.entries.some((entry) => entry.kind === "permission_review")).toBe(true);
    expect(result.current.entries.some((entry) => entry.kind === "assistant")).toBe(true);
  });

  it("keeps the verdict across an initial-session race and rewinds it with the transcript", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      result.current.appendUserEntry("세션 교체 전 요청");
      emitChatStream({
        type: "permission_review",
        reviewStatus: "auto_approved",
        name: "safe_tool",
        groupId: "g-load",
        toolUseId: "t-load",
        verdictLevel: "low",
      });
      emitChatStream({
        type: "tool_start",
        name: "safe_tool",
        groupId: "g-load",
        toolUseId: "t-load",
      });
    });
    expect(result.current.entries.some((entry) => entry.kind === "permission_review")).toBe(true);

    // An explicit session swap replaces the whole transcript.
    act(() => {
      result.current.applyLoadedSession([{ kind: "user", text: "loaded session" }]);
    });
    expect(result.current.entries).toEqual([{ kind: "user", text: "loaded session" }]);

    act(() => {
      result.current.appendUserEntry("초기 세션 경쟁 요청");
      emitChatStream({
        type: "permission_review",
        reviewStatus: "auto_approved",
        name: "safe_tool",
        groupId: "g-initial",
        toolUseId: "t-initial",
        verdictLevel: "low",
      });
      emitChatStream({
        type: "tool_start",
        name: "safe_tool",
        groupId: "g-initial",
        toolUseId: "t-initial",
      });
    });

    // A late initial-session hydration loses to live entries — including the verdict.
    act(() => {
      result.current.applyInitialSession([{ kind: "user", text: "ignored initial session" }]);
    });
    expect(result.current.entries.some((entry) => entry.kind === "permission_review")).toBe(true);
    expect(result.current.entries.some((entry) => entry.kind === "user" && entry.text === "ignored initial session")).toBe(false);

    act(() => {
      result.current.appendUserEntry("truncate 전 요청");
      emitChatStream({
        type: "permission_review",
        reviewStatus: "auto_approved",
        name: "safe_tool",
        groupId: "g-truncate",
        toolUseId: "t-truncate",
        verdictLevel: "low",
      });
      emitChatStream({
        type: "tool_start",
        name: "safe_tool",
        groupId: "g-truncate",
        toolUseId: "t-truncate",
      });
    });

    // Rewind keeps whatever survives the cut — nothing is erased out of band.
    act(() => {
      result.current.truncateToEntry(0);
    });
    expect(result.current.entries).toEqual([{ kind: "user", text: "loaded session" }]);
  });

  it("keeps overlay-import responses in the normal assistant stream", async () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));

    act(() => {
      result.current.insertImportedTriggerEntry({
        sessionId: "trigger-1",
        source: "plugin:meeting",
        prompt: "<imported-from-overlay source=\"overlay:meeting-summary\">요약</imported-from-overlay>",
        summary: "회의 요약",
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
        trigger: "auto-compact",
        summary: "이전 주제 요약",
      });
    });

    // The intent of this test is the checkpoint payload; context usage is
    // updated only when the engine includes `estimatedAfter`.
    await waitFor(() => {
      const checkpoint = result.current.entries.findLast((e) => e.kind === "checkpoint");
      expect(checkpoint).toMatchObject({
        kind: "checkpoint",
        removedMessages: 7,
        freedTokens: 123,
        trigger: "auto-compact",
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
        freshInputTokens: 10_000,
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
        freshInputTokens: 5_000,
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

  it("usedTokens reflects compact context carriers until a live turn summary arrives", () => {
    const loaded: ChatEntry[] = [
      { kind: "user", text: "이전 질문" },
      { kind: "assistant", text: "이전 답변", streaming: false },
      { kind: "context_usage", tokensIn: 12_345, source: "compact-estimate" },
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

  // Issue #900 #1 — TPM hint fields (tpmLimit / tpmPct / isTpmOverflow).
  // Hook 의 새 3 field 가 (a) tpmDefault 등록 모델 (nano) 에서 노출되고,
  // (b) 미등록 모델에서는 undefined 로 silent, (c) usedTokens >= tpmLimit
  // 시 isTpmOverflow 가 true 가 되는지 contract pin.
  it("tpmLimit/tpmPct/isTpmOverflow — gpt-5.4-nano returns numeric values", () => {
    const entries: ChatEntry[] = [
      {
        kind: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 100_000,
        freshInputTokens: 100_000,
        tokensOut: 200,
      },
    ];
    const { result } = renderHook(() =>
      useContextBudget({ entries, llmVendor: "openai", llmModel: "gpt-5.4-nano" }),
    );
    expect(result.current.tpmLimit).toBe(200_000);
    expect(result.current.tpmPct).toBeCloseTo(0.5, 5);
    expect(result.current.isTpmOverflow).toBe(false);
  });

  it("tpmLimit/tpmPct/isTpmOverflow — unregistered model returns undefined (backward-compat)", () => {
    const entries: ChatEntry[] = [
      {
        kind: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 100_000,
        freshInputTokens: 100_000,
        tokensOut: 200,
      },
    ];
    const { result } = renderHook(() =>
      useContextBudget({ entries, llmVendor: "openai", llmModel: "gpt-4o-mini" }),
    );
    expect(result.current.tpmLimit).toBeUndefined();
    expect(result.current.tpmPct).toBeUndefined();
    expect(result.current.isTpmOverflow).toBe(false);
  });

  it("isTpmOverflow trips when usedTokens >= tpmLimit (nano at 200K)", () => {
    const entries: ChatEntry[] = [
      {
        kind: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 200_000,
        freshInputTokens: 200_000,
        tokensOut: 100,
      },
    ];
    const { result } = renderHook(() =>
      useContextBudget({ entries, llmVendor: "openai", llmModel: "gpt-5.4-nano" }),
    );
    expect(result.current.tpmPct).toBeCloseTo(1.0, 5);
    expect(result.current.isTpmOverflow).toBe(true);
  });
});

describe("useCostEstimate (memo invariants)", () => {
  it("returns a cost object with a badge class", () => {
    const { result } = renderHook(() =>
      useCostEstimate({
        entries: [],
        draft: { text: "hello", attachments: [] },
        llmVendor: "openai",
        llmModel: "gpt-4o-mini",
        maxOutputTokens: 1024,
      }),
    );
    expect(result.current.costEstimate).toBeDefined();
    expect(typeof result.current.costBadgeClass).toBe("string");
    expect(result.current.costEstimate.total).toBeGreaterThanOrEqual(0);
  });
});

describe("useCurrentSession (streaming guard)", () => {
  it("handleLoadSession is a no-op while streaming=true", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));
    const setEntries = vi.fn();
    let loaded = true;
    await act(async () => {
      loaded = await result.current.handleLoadSession("other-sess", true, setEntries);
    });
    expect(loaded).toBe(false);
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    expect(setEntries).not.toHaveBeenCalled();
  });

  it("handleLoadSession loads when not streaming", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));
    const setEntries = vi.fn();
    let loaded = false;
    await act(async () => {
      loaded = await result.current.handleLoadSession("other-sess", false, setEntries);
    });
    expect(loaded).toBe(true);
    expect(api.chatSessionResume).toHaveBeenCalledWith("other-sess");
    expect(setEntries).toHaveBeenCalled();
  });

  it("handleLoadSession returns false when resume fails", async () => {
    const { api } = makeMockLvisApi();
    api.chatSessionResume.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
    });
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));
    const setEntries = vi.fn();
    let loaded = true;

    await act(async () => {
      loaded = await result.current.handleLoadSession("missing-sess", false, setEntries);
    });

    expect(loaded).toBe(false);
    expect(api.chatSessionHistory).not.toHaveBeenCalledWith("missing-sess");
    expect(setEntries).not.toHaveBeenCalled();
  });

  it("handleLoadSession replays structural history into chat entries", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));
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
      { kind: "assistant", text: "중간 답변", streaming: false, route: undefined, restored: true },
      { kind: "reasoning", text: "검증 계획", streaming: false },
      expect.objectContaining({ kind: "tool_group", status: "done" }),
      { kind: "assistant", text: "최종 답변", streaming: false, route: undefined, restored: true },
    ]);
    expect(result.current.currentSessionId).toBe("other-sess");
  });

  it("handleLoadSession does not synthesize a session-level context estimate", async () => {
    const { api } = makeMockLvisApi();
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));
    const setEntries = vi.fn();
    api.chatSessionHistory.mockClear();
    api.chatSessionHistory.mockResolvedValueOnce({
      ok: true,
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
      { kind: "assistant", text: "이전 답변", streaming: false, route: undefined, restored: true },
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
      useCurrentSession(api as unknown as LvisApi, { applyInitialSession: applyInitial }),
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

  it("refreshing the list cannot touch the session a tile is holding", async () => {
    const { api } = makeMockLvisApi({
      historyBySession: {
        "manual-sess": {
          sessionId: "manual-sess",
          sessionTitle: "Manual",
          messages: [{ index: 0, role: "user", content: "manual session" }],
        },
      },
    });
    const applyLoaded = vi.fn();
    const { result } = renderHook(() => useCurrentSession(api as unknown as LvisApi));

    await act(async () => {
      await result.current.handleLoadSession("manual-sess", false, applyLoaded);
    });

    expect(result.current.currentSessionId).toBe("manual-sess");
    expect(result.current.currentSessionTitle).toBe("Manual");
    api.chatGetHistory.mockClear();

    // The list is a SEPARATE hook now, so this is structural rather than a
    // promise: useSessionList holds no session metadata and never reads the
    // current session, which is why four tiles can share one list.
    const list = renderHook(() => useSessionList(api as unknown as LvisApi));
    await act(async () => {
      await list.result.current.refreshSessions();
    });

    expect(api.chatSessions).toHaveBeenCalled();
    expect(api.chatGetHistory).not.toHaveBeenCalled();
    expect(result.current.currentSessionId).toBe("manual-sess");
    expect(result.current.currentSessionTitle).toBe("Manual");
  });

  it("hydrates the explicit active main session on startup when active loop is empty", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "fresh-empty",
      history: { sessionId: "fresh-empty", messages: [] },
      sessions: [{ id: "persisted-sess", modifiedAt: new Date().toISOString(), title: "Persisted" }],
      mainActiveState: {
        mainActiveSessionId: "persisted-sess",
        mainActiveMode: "resume",
        updatedAt: new Date().toISOString(),
      },
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
      useCurrentSession(api as unknown as LvisApi, { applyInitialSession: applyInitial }),
    );

    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith("persisted-sess"));
    await waitFor(() => {
      expect(applyInitial).toHaveBeenCalledWith([
        { kind: "user", text: "이전 질문" },
        { kind: "assistant", text: "이전 답변", streaming: false, route: undefined, restored: true },
      ]);
    });
    expect(result.current.currentSessionId).toBe("persisted-sess");
  });

  it("hydrates active in-memory history with its context token estimate", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "active-sess",
      history: {
        sessionId: "active-sess",
        messages: [
          { index: 0, role: "user", content: "진행 중 질문" },
          { index: 1, role: "assistant", content: "진행 중 답변" },
        ],
      },
      mainActiveState: {
        mainActiveSessionId: "active-sess",
        mainActiveMode: "resume",
        updatedAt: "2026-05-11T03:00:00.000Z",
      },
    });
    const applyInitial = vi.fn();

    renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { applyInitialSession: applyInitial }),
    );

    await waitFor(() => {
      expect(applyInitial).toHaveBeenCalledWith([
        { kind: "user", text: "진행 중 질문" },
        { kind: "assistant", text: "진행 중 답변", streaming: false, route: undefined, restored: true },
      ]);
    });
  });

  it("ignores active routine history on startup and resumes the explicit active main session", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "routine-sess",
      history: {
        sessionId: "routine-sess",
        sessionKind: "routine",
        sessionTitle: "Daily routine",
        messages: [
          { index: 0, role: "user", content: "루틴 질문" },
          { index: 1, role: "assistant", content: "루틴 답변" },
        ],
      },
      mainActiveState: {
        mainActiveSessionId: "main-sess",
        mainActiveMode: "resume",
        updatedAt: "2026-05-11T03:00:00.000Z",
      },
      historyBySession: {
        "main-sess": {
          sessionId: "main-sess",
          sessionKind: "main",
          sessionTitle: "Main session",
          messages: [
            { index: 0, role: "user", content: "메인 질문" },
            { index: 1, role: "assistant", content: "메인 답변" },
          ],
        },
      },
    });
    const applyInitial = vi.fn();

    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { applyInitialSession: applyInitial }),
    );

    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith("main-sess"));
    expect(applyInitial).toHaveBeenCalledWith([
      { kind: "user", text: "메인 질문" },
      { kind: "assistant", text: "메인 답변", streaming: false, route: undefined, restored: true },
    ]);
    expect(result.current.currentSessionId).toBe("main-sess");
    expect(result.current.currentSessionKind).toBe("main");
    expect(result.current.currentSessionTitle).toBe("Main session");
  });

  it("resets routine in-memory history to a blank main session when active main state is fresh", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "routine-sess",
      history: {
        sessionId: "routine-sess",
        sessionKind: "routine",
        messages: [
          { index: 0, role: "user", content: "루틴 질문" },
        ],
      },
      mainActiveState: {
        mainActiveSessionId: null,
        mainActiveMode: "fresh",
        updatedAt: "2026-05-11T03:00:00.000Z",
      },
    });
    api.chatGetHistory.mockReset();
    api.chatGetHistory
      .mockResolvedValueOnce({
        sessionId: "routine-sess",
        sessionKind: "routine",
        messages: [{ index: 0, role: "user", content: "루틴 질문" }],
      })
      .mockResolvedValueOnce({
        sessionId: "fresh-main",
        sessionKind: "main",
        messages: [],
      });
    const applyInitial = vi.fn();

    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { applyInitialSession: applyInitial }),
    );

    await waitFor(() => expect(api.chatNew).toHaveBeenCalledTimes(1));
    expect(applyInitial).toHaveBeenCalledWith([]);
    expect(result.current.currentSessionId).toBe("fresh-main");
    expect(result.current.currentSessionKind).toBe("main");
  });

  it("does not auto-resume the latest listed session when active main state is fresh", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "fresh-empty",
      history: { sessionId: "fresh-empty", messages: [] },
      sessions: [
        { id: "today-early", modifiedAt: "2026-05-10T23:00:00.000Z", title: "Today early" },
        { id: "yesterday-late", modifiedAt: "2026-05-10T14:59:59.000Z", title: "Yesterday late" },
        { id: "today-late", modifiedAt: "2026-05-11T02:30:00.000Z", title: "Today late" },
      ],
      mainActiveState: {
        mainActiveSessionId: null,
        mainActiveMode: "fresh",
        updatedAt: "2026-05-11T03:00:00.000Z",
      },
    });
    const applyInitial = vi.fn();

    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { applyInitialSession: applyInitial }),
    );

    await waitFor(() => expect(api.chatMainActiveState).toHaveBeenCalled());
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    expect(applyInitial).toHaveBeenCalledWith([]);
    expect(result.current.currentSessionId).toBe("fresh-empty");
  });

  it("resumes the explicit active main session regardless of modified date", async () => {
    const { api } = makeMockLvisApi({
      currentSession: "fresh-empty",
      history: { sessionId: "fresh-empty", messages: [] },
      sessions: [
        { id: "today-late", modifiedAt: "2026-05-11T02:30:00.000Z", title: "Today late" },
        { id: "yesterday-late", modifiedAt: "2026-05-10T14:59:59.000Z", title: "Yesterday late" },
      ],
      mainActiveState: {
        mainActiveSessionId: "yesterday-late",
        mainActiveMode: "resume",
        updatedAt: "2026-05-11T03:00:00.000Z",
      },
    });
    api.chatSessionHistory.mockResolvedValueOnce({
      ok: true,
      messages: [
        { index: 0, role: "user", content: "명시 active 질문" },
        { index: 1, role: "assistant", content: "명시 active 답변" },
      ],
    });
    const applyInitial = vi.fn();

    const { result } = renderHook(() =>
      useCurrentSession(api as unknown as LvisApi, { applyInitialSession: applyInitial }),
    );

    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith("yesterday-late"));
    expect(api.chatSessionResume).not.toHaveBeenCalledWith("today-late");
    expect(result.current.currentSessionId).toBe("yesterday-late");
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

describe("useChatState — a turn interrupted by the next send", () => {
  const mount = () => {
    const { api, emitChatStream } = makeMockLvisApi();
    const { result } = renderHook(() => useChatState(api as unknown as LvisApi));
    return { result, dispatch: (ev: Parameters<typeof emitChatStream>[0]) => act(() => emitChatStream(ev)) };
  };

  it("keeps the interrupted entry open until its own closing frame, which lands after the new question", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "partial answer" });
    act(() => result.current.markLastAssistantInterrupted());
    act(() => result.current.appendUserEntry("second"));
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    expect(result.current.entries[1]).toMatchObject({ interrupted: true, streaming: true });

    dispatch({ type: "done", streamId: 1 });
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    expect(result.current.entries[1]).toMatchObject({ kind: "assistant", text: "partial answer", interrupted: true, streaming: false });
  });

  it("keeps the interrupted marker through deltas that were still in flight", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "part" });
    act(() => result.current.markLastAssistantInterrupted());
    dispatch({ type: "text_delta", streamId: 1, text: "ial" });
    expect(result.current.entries[1]).toMatchObject({ text: "partial", interrupted: true, streaming: true });
    dispatch({ type: "done", streamId: 1 });
    expect(result.current.entries[1]).toMatchObject({ text: "partial", interrupted: true, streaming: false });
  });

  it("keeps the delivered text when the interrupted turn closes with an error frame", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "partial answer" });
    act(() => result.current.markLastAssistantInterrupted());
    dispatch({ type: "error", streamId: 1, error: "aborted" });
    expect(result.current.entries[1]).toMatchObject({ text: "partial answer", interrupted: true, streaming: false });
  });

  it("closes the interrupted stream when the next stream speaks first, and gives the new text its own entry", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "partial answer" });
    act(() => result.current.markLastAssistantInterrupted());
    act(() => result.current.appendUserEntry("second"));
    // The first turn rejected instead of settling: no done, no error — only the new stream arrives.
    dispatch({ type: "text_delta", streamId: 2, text: "fresh" });
    dispatch({ type: "done", streamId: 2 });

    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(result.current.entries[1]).toMatchObject({ text: "partial answer", interrupted: true, streaming: false });
    expect(result.current.entries[3]).toMatchObject({ text: "fresh", streaming: false });
    expect(result.current.entries[3]).not.toHaveProperty("interrupted");
    // A straggler from the old stream is dropped, not adopted.
    dispatch({ type: "text_delta", streamId: 1, text: " late" });
    expect(result.current.entries[1]).toMatchObject({ text: "partial answer" });
    expect(result.current.entries).toHaveLength(4);
  });

  it("marks the current turn's answer even after its done frame — the Stop button resolves after the stream closed", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "done answer" });
    dispatch({ type: "done", streamId: 1 });
    act(() => result.current.markLastAssistantInterrupted());
    expect(result.current.entries[1]).toMatchObject({ text: "done answer", interrupted: true, streaming: false });
  });

  it("leaves the previous turn's answer alone when the current turn has produced none yet", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "earlier answer" });
    dispatch({ type: "done", streamId: 1 });
    act(() => result.current.appendUserEntry("second"));
    act(() => result.current.markLastAssistantInterrupted());
    expect(result.current.entries[1]).not.toHaveProperty("interrupted");
    expect(result.current.entries).toHaveLength(3);
  });

  it("takes the marker back when the host refuses the interrupting send, and the turn goes on", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "part" });
    act(() => result.current.markLastAssistantInterrupted());
    act(() => result.current.unmarkLastAssistantInterrupted());
    expect(result.current.entries[1]).not.toHaveProperty("interrupted");
    dispatch({ type: "text_delta", streamId: 1, text: "ial" });
    dispatch({ type: "done", streamId: 1 });
    expect(result.current.entries[1]).toMatchObject({ text: "partial", streaming: false });
    expect(result.current.entries[1]).not.toHaveProperty("interrupted");
  });

  it("supersedes a tool-only turn without leaving a stray entry, and lets the retired stream close its tool card", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "tool_start", streamId: 1, name: "slow_tool", groupId: "g1", toolUseId: "t1" });
    act(() => result.current.markLastAssistantInterrupted());
    act(() => result.current.appendUserEntry("second"));
    dispatch({ type: "text_delta", streamId: 2, text: "fresh" });
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "tool_group", "user", "assistant"]);
    expect(result.current.entries[3]).toMatchObject({ text: "fresh", streaming: true });

    // The old stream's tool result still arrives — the card must not stay "running".
    dispatch({ type: "tool_end", streamId: 1, name: "slow_tool", groupId: "g1", toolUseId: "t1", result: "aborted" });
    const group = result.current.entries[1] as Extract<typeof result.current.entries[number], { kind: "tool_group" }>;
    expect(group.tools[0]).toMatchObject({ toolUseId: "t1", status: "done" });
    expect(result.current.entries[3]).toMatchObject({ text: "fresh", streaming: true });

    dispatch({ type: "done", streamId: 2 });
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "tool_group", "user", "assistant"]);
    expect(result.current.entries[3]).toMatchObject({ text: "fresh", streaming: false });
  });

  it("supersedes on the new stream's status frame, before any text of its own", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "partial answer" });
    act(() => result.current.markLastAssistantInterrupted());
    act(() => result.current.appendUserEntry("second"));
    dispatch({ type: "llm_status", streamId: 2, phase: "retry", attempt: 1, maxAttempts: 5 });
    expect(result.current.entries[1]).toMatchObject({ text: "partial answer", interrupted: true, streaming: false });
    dispatch({ type: "text_delta", streamId: 2, text: "fresh" });
    dispatch({ type: "done", streamId: 2 });
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(result.current.entries[3]).toMatchObject({ text: "fresh", streaming: false });
  });

  it("marks the streaming answer even after guidance was injected behind it", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "partial" });
    dispatch({ type: "guidance_injected", streamId: 1, text: "steer this way" });
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user"]);
    act(() => result.current.markLastAssistantInterrupted());
    expect(result.current.entries[1]).toMatchObject({ text: "partial", interrupted: true });
  });

  it("does not reach back past a drained queue line to a finished answer", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "earlier answer" });
    dispatch({ type: "done", streamId: 1 });
    act(() => result.current.appendUserEntry("queued", "queue"));
    dispatch({ type: "tool_start", streamId: 2, name: "slow_tool", groupId: "g2", toolUseId: "t2" });
    act(() => result.current.markLastAssistantInterrupted());
    expect(result.current.entries[1]).not.toHaveProperty("interrupted");
  });

  it("does not let an older stream's straggler take the active slot while an interrupt is armed", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "old answer" });
    dispatch({ type: "done", streamId: 1 });
    act(() => result.current.appendUserEntry("second"));
    dispatch({ type: "text_delta", streamId: 2, text: "current" });
    act(() => result.current.markLastAssistantInterrupted());
    // A late frame of stream 1 is not the successor of stream 2.
    dispatch({ type: "text_delta", streamId: 1, text: " late" });
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(result.current.entries[3]).toMatchObject({ text: "current", interrupted: true, streaming: true });
    dispatch({ type: "done", streamId: 2 });
    expect(result.current.entries[3]).toMatchObject({ text: "current", interrupted: true, streaming: false });
    // The next real turn still renders.
    act(() => result.current.appendUserEntry("third"));
    dispatch({ type: "text_delta", streamId: 3, text: "next" });
    expect(result.current.entries[5]).toMatchObject({ text: "next", streaming: true });
  });

  it("forgets the retired stream on a new chat, so the id can be reused", () => {
    const { result, dispatch } = mount();
    act(() => result.current.appendUserEntry("first"));
    dispatch({ type: "text_delta", streamId: 1, text: "partial" });
    act(() => result.current.markLastAssistantInterrupted());
    dispatch({ type: "text_delta", streamId: 2, text: "fresh" });
    dispatch({ type: "done", streamId: 2 });
    act(() => result.current.clearForNewChat());
    act(() => result.current.appendUserEntry("again"));
    dispatch({ type: "text_delta", streamId: 1, text: "reused id" });
    expect(result.current.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
    expect(result.current.entries[1]).toMatchObject({ text: "reused id", streaming: true });
  });
});
