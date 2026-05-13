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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function submitUser(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea).toBeTruthy();
  await act(async () => {
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
  });
}

function kstDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

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

  it("keeps the session todo dock edge-to-edge above the composer", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await waitFor(() => {
      const dock = container.querySelector('[data-testid="session-todo-dock"]');
      expect(dock).not.toBeNull();
      expect(dock).toHaveClass("w-full");
      expect(dock?.className).not.toContain("px-");
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

  it("collapses pre-final assistant work and tools into one turn WorkGroup", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "일정 확인");
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
        result: "__calendar_result__",
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
      // Tighter than two separate `toContain("작업")` + `toContain("2단계")` —
      // those would pass even if WorkGroup spans degenerated to `작업단계`
      // (lost the count). `/작업\s*\d+단계/` requires the count digit between
      // the label and the suffix, which is what WorkGroup actually renders.
      expect(container.textContent).toMatch(/작업\s*2단계/);
      expect(container.textContent).not.toContain("calendar list");
      expect(container.textContent).not.toContain("__calendar_result__");
      expect(container.textContent).toContain("두번째 답변입니다");
      expect(container.textContent).not.toContain("첫번째 답변입니다");
    });

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"work-group\"] button")!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("첫번째 답변입니다");
      expect(container.textContent).toContain("calendar list");
      expect(container.textContent).not.toContain("__calendar_result__");
    });

    const toolButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("calendar list"),
    ) as HTMLButtonElement | undefined;
    expect(toolButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(toolButton!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("__calendar_result__");
    });
  });

  it("keeps a one-step pre-final assistant round inside WorkGroup", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "추론 확인");
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
      expect(container.textContent).toMatch(/작업\s*2단계/);
      expect(container.textContent).toContain("최종 답변입니다");
      expect(container.textContent).not.toContain("첫번째 답변입니다");
    });

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"work-group\"] button")!);
    });

    for (const button of Array.from(container.querySelectorAll("button"))) {
      if (button.textContent?.includes("생각 완료")) {
        await act(async () => {
          fireEvent.click(button);
        });
      }
    }

    await waitFor(() => {
      expect(container.textContent).toContain("첫번째 답변입니다");
      expect(container.textContent).toContain("생각 완료");
    });
  });

  it("keeps completed prior turns visible while a new turn is streaming", async () => {
    const { container, api, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "첫 질문");
    await act(async () => {
      emitChatStream({ type: "reasoning_delta", text: "첫 턴 생각" });
      emitChatStream({ type: "text_delta", text: "첫 최종 답변" });
      emitChatStream({
        type: "assistant_round",
        text: "첫 최종 답변",
        thought: "첫 턴 생각",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("첫 최종 답변");
      expect(container.textContent).not.toContain("첫 턴 생각");
    });

    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitUser(container, "둘째 질문");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "둘째 답변 작성 중" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("첫 최종 답변");
      expect(container.textContent).toContain("둘째 답변 작성 중");
      expect(container.textContent).toContain("작업 중...");
    });
    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("moves a tool_use assistant round into the active WorkGroup before tool events arrive", async () => {
    const { container, api, emitChatStream } = await renderApp({ hasApiKey: true });
    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitUser(container, "직접 도구 호출");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "도구를 바로 호출하겠습니다" });
      emitChatStream({
        type: "assistant_round",
        text: "도구를 바로 호출하겠습니다",
        thought: "",
        stopReason: "tool_use",
        hasToolCalls: true,
      });
    });

    await waitFor(() => {
      const workGroup = container.querySelector("[data-testid=\"work-group\"]");
      expect(workGroup).toBeTruthy();
      expect(workGroup!.textContent).toContain("작업 중...");
      expect(workGroup!.textContent).toContain("도구를 바로 호출하겠습니다");
    });
    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("strips meta markers and renders Markdown for assistant_round text", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "마크다운 확인");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "결과는 **정상**입니다.<title>마크다운 렌더링 확인</title>" });
      emitChatStream({
        type: "assistant_round",
        text: "결과는 **정상**입니다.<title>마크다운 렌더링 확인</title>",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("결과는 정상입니다.");
      expect(container.textContent).not.toContain("<title>");
      expect(container.querySelector('[data-testid="assistant-message-body"] strong')?.textContent).toBe("정상");
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

  it("hydrates current-session backlog history on mount", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      history: {
        sessionId: "sess-history",
        messages: [
          { index: 0, role: "user", content: "이전 질문" },
          { index: 1, role: "assistant", content: "이전 답변" },
        ],
      },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("이전 질문");
      expect(container.textContent).toContain("이전 답변");
    });
  });

  it("does not let delayed startup history overwrite a live user turn", async () => {
    const history = deferred<{
      sessionId: string;
      messages: Array<{ index: number; role: "user" | "assistant" | "tool_result"; content: string }>;
    }>();
    const { container, api, emitChatStream } = await renderApp({
      hasApiKey: true,
      history: history.promise,
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "방금 보낸 질문" } });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "실시간 답변" });
      history.resolve({
        sessionId: "stale-startup-session",
        messages: [
          { index: 0, role: "user", content: "이전 질문" },
          { index: 1, role: "assistant", content: "이전 답변" },
        ],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("방금 보낸 질문");
      expect(container.textContent).toContain("실시간 답변");
      expect(container.textContent).not.toContain("이전 질문");
      expect(container.textContent).not.toContain("이전 답변");
    });
  });

  it("keeps completed prior turns visible while a new turn is streaming", async () => {
    const { container, api, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "첫 질문");
    await act(async () => {
      emitChatStream({ type: "reasoning_delta", text: "첫 턴 생각" });
      emitChatStream({ type: "text_delta", text: "첫 최종 답변" });
      emitChatStream({
        type: "assistant_round",
        text: "첫 최종 답변",
        thought: "첫 턴 생각",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("첫 최종 답변");
      expect(container.textContent).not.toContain("첫 턴 생각");
    });

    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitUser(container, "둘째 질문");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "둘째 답변 작성 중" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("첫 최종 답변");
      expect(container.textContent).toContain("둘째 답변 작성 중");
      expect(container.textContent).toContain("작업 중...");
    });
    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("collapses standalone reasoning when thinking completes", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "생각만 확인");
    await act(async () => {
      emitChatStream({ type: "reasoning_delta", text: "완료되면 접혀야 하는 생각" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("생각 중...");
      expect(container.textContent).toContain("완료되면 접혀야 하는 생각");
    });

    await act(async () => {
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      // PR #623: standalone reasoning collapses to "생각 완료" header with
      // the raw thought hidden. The legacy "응답이 비어있습니다." placeholder
      // is no longer rendered for tool/text-empty turns.
      expect(container.textContent).toContain("생각 완료");
      expect(container.textContent).not.toContain("응답이 비어있습니다.");
      expect(container.textContent).not.toContain("완료되면 접혀야 하는 생각");
    });
  });

  it("renders ask_user_question in the bottom overlay without scrolling chat history", async () => {
    const { container, emitAskUserQuestion } = await renderApp({ hasApiKey: true });

    await act(async () => {
      emitAskUserQuestion({
        id: "ask-scroll-1",
        createdAt: Date.now(),
        questions: [
          {
            question: "지역 기준을 알려주세요",
            choices: ["서울", "경기"],
            allowFreeText: true,
          },
        ],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("지역 기준을 알려주세요");
      const overlay = container.querySelector('[data-testid="question-overlay"]');
      const card = container.querySelector('[data-testid="ask-user-question-card"]');
      expect(overlay).not.toBeNull();
      expect(overlay?.className).not.toContain("pb-3");
      expect(card).toHaveClass("rounded-none");
      expect(card).toHaveClass("rounded-t-lg");
      expect(card).toHaveClass("border-b-0");
    });
  });

  it("keeps the calendar day divider visible for the active conversation after previous-day history loads", async () => {
    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { container } = await renderApp({
      currentSession: "current",
      sessions: [
        { id: "current", modifiedAt: now, title: "현재 대화" },
        { id: "old-yesterday", modifiedAt: yesterday, title: "이전 대화" },
      ],
      history: {
        sessionId: "current",
        messages: [],
      },
      historyBySession: {
        "old-yesterday": {
        messages: [
          { index: 0, role: "user", content: "이전 질문" },
          { index: 1, role: "assistant", content: "이전 답변" },
        ],
        },
      },
    });

    await submitUser(container, "새 질문");

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="day-divider"]').length).toBeGreaterThanOrEqual(2);
      expect(container.textContent).not.toContain("현재 대화");
    });
  });

  it("scrolls to an already loaded historical session from the calendar session list", async () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const now = new Date().toISOString();
    const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterday = yesterdayDate.toISOString();
    const yesterdayKey = kstDateKey(yesterdayDate);
    const { container } = await renderApp({
      currentSession: "current",
      sessions: [
        { id: "current", modifiedAt: now, title: "현재 대화" },
        { id: "old-yesterday", modifiedAt: yesterday, title: "이전 대화" },
      ],
      history: {
        sessionId: "current",
        messages: [],
      },
      historyBySession: {
        "old-yesterday": {
          messages: [
            { index: 0, role: "user", content: "이전 질문" },
            { index: 1, role: "assistant", content: "이전 답변" },
          ],
        },
      },
    });

    await waitFor(() => {
      expect(container.querySelector('[data-session-marker-id="old-yesterday"]')).toBeTruthy();
    });

    const dayButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(yesterdayKey),
    ) as HTMLButtonElement | undefined;
    expect(dayButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(dayButton!);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("이전 대화");
    });

    const sessionButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("이전 대화"),
    ) as HTMLButtonElement | undefined;
    expect(sessionButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(sessionButton!);
    });

    expect(scrollSpy).toHaveBeenCalled();
  });

  it("moves a tool_use assistant round into the active WorkGroup before tool events arrive", async () => {
    const { container, api, emitChatStream } = await renderApp({ hasApiKey: true });
    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitUser(container, "직접 도구 호출");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "도구를 바로 호출하겠습니다" });
      emitChatStream({
        type: "assistant_round",
        text: "도구를 바로 호출하겠습니다",
        thought: "",
        stopReason: "tool_use",
        hasToolCalls: true,
      });
    });

    await waitFor(() => {
      const workGroup = container.querySelector("[data-testid=\"work-group\"]");
      expect(workGroup).toBeTruthy();
      expect(workGroup!.textContent).toContain("작업 중...");
      expect(workGroup!.textContent).toContain("도구를 바로 호출하겠습니다");
    });
    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("strips meta markers and renders Markdown for assistant_round text", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "마크다운 확인");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "결과는 **정상**입니다.<title>마크다운 렌더링 확인</title>" });
      emitChatStream({
        type: "assistant_round",
        text: "결과는 **정상**입니다.<title>마크다운 렌더링 확인</title>",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("결과는 정상입니다.");
      expect(container.textContent).not.toContain("<title>");
      expect(container.querySelector('[data-testid="assistant-message-body"] strong')?.textContent).toBe("정상");
    });
  });

  // Regression guard for Copilot PR #545 round-1 comments ③④.
  // Reasoning + tool + assistant sequence: reasoning entry must be bucketed
  // inside WorkGroup while the final assistant text stays visible standalone.
  it("keeps reasoning bucketed in WorkGroup while assistant text stays visible (reasoning+tool+end_turn)", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitUser(container, "오늘 일정");
    await act(async () => {
      // reasoning phase
      emitChatStream({ type: "reasoning_delta", text: "사용자 질문을 분석합니다" });
      // tool call
      emitChatStream({ type: "tool_start", name: "calendar_list", groupId: "g1", toolUseId: "t1" });
      emitChatStream({ type: "tool_end", name: "calendar_list", groupId: "g1", toolUseId: "t1", result: "__calendar_result__", isError: false });
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
      // Reasoning and tool results are one completed WorkGroup and collapse together.
      expect(container.textContent).toMatch(/작업\s*2단계/);
      expect(container.textContent).not.toContain("calendar list");
      expect(container.textContent).not.toContain("__calendar_result__");
    });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"work-group\"] button")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("calendar list");
      expect(container.textContent).not.toContain("__calendar_result__");
    });
    const toolButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("calendar list"),
    ) as HTMLButtonElement | undefined;
    expect(toolButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(toolButton!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("__calendar_result__");
    });
  });

  it("replays persisted pre-final assistant work as one collapsed turn WorkGroup", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      history: {
        sessionId: "sess-work-order",
        messages: [
          { index: 0, role: "user", content: "작업 순서 확인" },
          {
            index: 1,
            role: "assistant",
            content: "",
            thought: "첫 번째 검색 계획",
            toolCalls: [{ id: "t1", name: "web_search", input: { q: "LVIS" } }],
          },
          { index: 2, role: "tool_result", toolUseId: "t1", toolName: "web_search", content: "검색 결과" },
          { index: 3, role: "assistant", content: "중간 확인 내용은 사용자에게 보여야 합니다." },
          {
            index: 4,
            role: "assistant",
            content: "",
            thought: "두 번째 도구 결과를 검증",
            toolCalls: [{ id: "t2", name: "web_fetch", input: { url: "https://example.com" } }],
          },
          { index: 5, role: "tool_result", toolUseId: "t2", toolName: "web_fetch", content: "본문" },
          { index: 6, role: "assistant", content: "최종 답변입니다." },
        ],
      },
    });

    await waitFor(() => {
      const transcriptText = container.textContent ?? "";
      expect(transcriptText).toContain("5단계");
      expect(transcriptText).toContain("최종 답변입니다.");
      expect(transcriptText).not.toContain("웹 검색");
      expect(transcriptText).not.toContain("검색 결과");
      expect(transcriptText).not.toContain("웹 페이지 가져오기");
      expect(transcriptText).not.toContain("본문");
      expect(transcriptText).not.toContain("중간 확인 내용은 사용자에게 보여야 합니다.");
      expect(container.querySelectorAll("[data-testid=\"work-group\"]")).toHaveLength(1);
    });

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"work-group\"] button")!);
    });

    await waitFor(() => {
      const transcriptText = container.textContent ?? "";
      const middle = transcriptText.indexOf("중간 확인 내용은 사용자에게 보여야 합니다.");
      const final = transcriptText.indexOf("최종 답변입니다.");
      expect(transcriptText).not.toContain("첫 번째 검색 계획");
      expect(transcriptText).not.toContain("두 번째 도구 결과를 검증");
      expect(transcriptText).toContain("웹 검색");
      expect(transcriptText).toContain("웹 페이지 가져오기");
      expect(transcriptText).not.toContain("검색 결과");
      expect(transcriptText).not.toContain("본문");
      expect(middle).toBeGreaterThanOrEqual(0);
      expect(final).toBeGreaterThan(middle);
    });

    const toolButtons = Array.from(container.querySelectorAll("button"));
    const searchToolButton = toolButtons.find((button) => button.textContent?.includes("웹 검색")) as HTMLButtonElement | undefined;
    const fetchToolButton = toolButtons.find((button) => button.textContent?.includes("웹 페이지 가져오기")) as HTMLButtonElement | undefined;
    expect(searchToolButton).toBeTruthy();
    expect(fetchToolButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(searchToolButton!);
      fireEvent.click(fetchToolButton!);
    });

    await waitFor(() => {
      const transcriptText = container.textContent ?? "";
      expect(transcriptText).toContain("검색 결과");
      expect(transcriptText).toContain("본문");
    });
  });

  it("keeps pre-final search matches collapsed while preserving final highlight", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      history: {
        sessionId: "sess-search-rings",
        messages: [
          { index: 0, role: "user", content: "검색 링 확인" },
          {
            index: 1,
            role: "assistant",
            content: "",
            thought: "첫 번째 작업",
            toolCalls: [{ id: "t1", name: "web_search", input: { q: "needle" } }],
          },
          { index: 2, role: "tool_result", toolUseId: "t1", toolName: "web_search", content: "검색 결과" },
          { index: 3, role: "assistant", content: "needle 중간 답변은 계속 보여야 합니다." },
          {
            index: 4,
            role: "assistant",
            content: "",
            thought: "두 번째 작업",
            toolCalls: [{ id: "t2", name: "web_fetch", input: { url: "https://example.com" } }],
          },
          { index: 5, role: "tool_result", toolUseId: "t2", toolName: "web_fetch", content: "본문" },
          { index: 6, role: "assistant", content: "needle 최종 답변입니다." },
        ],
      },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("needle 최종 답변입니다.");
      expect(container.textContent).not.toContain("needle 중간 답변은 계속 보여야 합니다.");
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    const input = await waitFor(() => {
      const el = container.querySelector('input[placeholder="대화·세션·즐겨찾기·루틴·메모리 검색..."]') as HTMLInputElement | null;
      expect(el).toBeTruthy();
      return el;
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "needle" } });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("1/2");
    });

    const assistantBodies = Array.from(container.querySelectorAll('[data-testid="assistant-message-body"]'));
    const finalBody = assistantBodies.find((el) => el.textContent?.includes("최종 답변")) as HTMLElement | undefined;
    const finalRingWrapper = finalBody?.parentElement?.parentElement;

    expect(finalRingWrapper?.className).toContain("ring-1 ring-primary/40");
  });

});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
