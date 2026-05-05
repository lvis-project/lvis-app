/**
 * ChatView unit tests.
 *
 * ChatView relies heavily on useChatContext() so tests render the full <App />
 * via the shared renderApp helper and assert ChatView-specific behaviour.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";

describe("ChatView", () => {
  it("mounts without crashing", async () => {
    const { container } = await renderApp();
    expect(container).toBeTruthy();
  });

  it("shows API key prompt when hasApiKey is false", async () => {
    const { container } = await renderApp({ hasApiKey: false });
    await waitFor(() => {
      expect(container.textContent).toContain("API 키 설정 필요");
    });
  });

  it("renders empty-state message when no entries", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await waitFor(() => {
      expect(container.textContent).toContain("LVIS 에이전트가 준비되었습니다");
    });
  });

  it("renders assistant text after stream text_delta event", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "안녕하세요" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("안녕하세요");
    });
  });

  it("Ctrl+C on input element does NOT call preventDefault (Issue 2 fix)", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    // Start streaming so the Ctrl+C handler is active
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "streaming..." });
    });
    await waitFor(() => expect(container.textContent).toContain("streaming..."));

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // Focus the textarea so it is the active element
    textarea.focus();

    // Simulate Ctrl+C on window while textarea has focus — guard must allow native copy
    let defaultPrevented = false;
    await act(async () => {
      const event = new KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      // Dispatch on textarea so event.target is the input element
      textarea.dispatchEvent(event);
      defaultPrevented = event.defaultPrevented;
    });

    // The handler must NOT call preventDefault when target is an editable element
    expect(defaultPrevented).toBe(false);
  });

  it("Enter key on textarea calls chatSend", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "test message" } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
  });

  // Regression 2026-05-04 — multi-round turns rendered the first assistant
  // bubble inside an auto-collapsing WorkGroup ("작업 N단계 ▶"). After the
  // turn finished, the WorkGroup collapsed and the user only saw the second
  // round's text — looked like the front of the response was truncated.
  it("keeps both assistant texts visible across a tool-use multi-round turn", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await act(async () => {
      // Round 1 — text + tool_use
      emitChatStream({ type: "text_delta", text: "첫번째 답변입니다" });
      emitChatStream({
        type: "assistant_round",
        text: "첫번째 답변입니다",
        thought: "",
        stopReason: "tool_use",
        hasToolCalls: true,
      });
      emitChatStream({
        type: "tool_start",
        name: "calendar_list",
        groupId: "g1",
        toolUseId: "t1",
      });
      emitChatStream({
        type: "tool_end",
        name: "calendar_list",
        groupId: "g1",
        toolUseId: "t1",
        result: "ok",
        isError: false,
      });
      // Round 2 — final answer + end_turn
      emitChatStream({ type: "text_delta", text: "두번째 답변입니다" });
      emitChatStream({
        type: "assistant_round",
        text: "두번째 답변입니다",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      // Both round texts must remain in the rendered DOM after the turn ends.
      expect(container.textContent).toContain("첫번째 답변입니다");
      expect(container.textContent).toContain("두번째 답변입니다");
      // Single-step intermediate group (one tool entry) renders without
      // the "작업 N단계" WorkGroup wrapper after de72933 — the tool card
      // is shown directly. Pre-classifier-fix the round-1 assistant was
      // bucketed as `intermediate` too, producing a 2-entry group with
      // "작업 2단계" header. Now we assert the *absence* of the wrapper
      // text as proof that round-1 assistant was carved out correctly.
      expect(container.textContent).not.toContain("작업 2단계");
    });
  });

  // Regression 2026-05-04 — reasoning + assistant interleaving.
  // When a turn contains [assistant(round1), reasoning, assistant(round2)],
  // the round-1 assistant must stay visible as a standalone card and must
  // NOT be pulled into the auto-collapsing WorkGroup alongside the reasoning
  // entry. Pre-fix the classifier treated any entry followed by more turn
  // content as `intermediate` regardless of kind, so round-1 assistant +
  // reasoning both collapsed into "작업 2단계 ▶". Post-fix assistant entries
  // are always `live`, leaving only the reasoning entry in the WorkGroup
  // ("1단계").
  it("keeps assistant text visible when reasoning follows in the same turn", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await act(async () => {
      // Round 1 — text, finalized as tool_use (no actual tool events follow)
      emitChatStream({ type: "text_delta", text: "첫번째 답변입니다" });
      emitChatStream({
        type: "assistant_round",
        text: "첫번째 답변입니다",
        thought: "",
        stopReason: "tool_use",
        hasToolCalls: false,
      });
      // Round 2 — reasoning phase, then final answer
      emitChatStream({ type: "reasoning_delta", text: "생각 중입니다" });
      emitChatStream({
        type: "assistant_round",
        text: "최종 답변입니다",
        thought: "생각 중입니다",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      // Both assistant texts must remain visible after the turn ends.
      expect(container.textContent).toContain("첫번째 답변입니다");
      expect(container.textContent).toContain("최종 답변입니다");
      // Single-step intermediate (just the reasoning entry) renders the
      // ReasoningCard directly without "작업 N단계" WorkGroup wrapper after
      // de72933 — the "생각 정리" header proves the reasoning entry was
      // produced as a single intermediate, and the absence of "작업 2단계"
      // proves the round-1 assistant was correctly carved out.
      expect(container.textContent).toContain("생각 정리");
      expect(container.textContent).not.toContain("작업 2단계");
    });
  });

  // Regression 2026-05-05 — engine-emitted empty `assistant_round.text`
  // overwrote the renderer's delta-accumulated body. With `ev.text ?? streamRef`,
  // an empty string is non-nullish so `??` picks it, leaving the assistant
  // entry blank. Fix: `ev.text || streamRef.current` so empty falls through
  // to the accumulated body. (User report: "결론 본문이 사라지고 마커만 남는".)
  it("preserves accumulated body when assistant_round.text is empty-string", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await act(async () => {
      // Full body streams via deltas
      emitChatStream({ type: "text_delta", text: "본문이 정상적으로 누적되었습니다" });
      // Engine emits assistant_round with EMPTY text (the bug trigger)
      emitChatStream({
        type: "assistant_round",
        text: "",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      // Body must survive — pre-fix it was wiped because empty `ev.text`
      // beat the accumulated streamRef under `??` precedence.
      expect(container.textContent).toContain("본문이 정상적으로 누적되었습니다");
    });
  });

  // Regression guard for Copilot PR #545 round-1 comments ③④.
  // Reasoning + tool + assistant sequence: reasoning entry must be bucketed
  // inside WorkGroup while the final assistant text stays visible standalone.
  it("keeps reasoning bucketed in WorkGroup while assistant text stays visible (reasoning+tool+end_turn)", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await act(async () => {
      // reasoning phase
      emitChatStream({ type: "reasoning_delta", text: "사용자 질문을 분석합니다" });
      // tool call
      emitChatStream({ type: "tool_start", name: "calendar_list", groupId: "g1", toolUseId: "t1" });
      emitChatStream({ type: "tool_end", name: "calendar_list", groupId: "g1", toolUseId: "t1", result: "ok", isError: false });
      // final assistant round
      emitChatStream({ type: "text_delta", text: "오늘 일정 정리해드릴게요" });
      emitChatStream({
        type: "assistant_round",
        text: "오늘 일정 정리해드릴게요",
        thought: "사용자 질문을 분석합니다",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      // Final assistant text must be visible
      expect(container.textContent).toContain("오늘 일정 정리해드릴게요");
      // WorkGroup bundles reasoning + tool (2단계), assistant stays outside
      expect(container.textContent).toContain("2단계");
    });
  });

});

afterEach(() => {
  vi.unstubAllGlobals();
});
