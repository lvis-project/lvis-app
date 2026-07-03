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
import { deferred, submitChatMessage } from "../../../../test/renderer/helpers.js";
import {
  __resetSuggestedRepliesStoreForTests,
  __teardownSuggestedRepliesIpcForTests,
} from "../hooks/use-suggested-replies.js";

function installDeterministicScrollMetrics(scrollHeight = 2400, clientHeight = 600) {
  const descriptors = {
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
    scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop"),
  };
  let assignedScrollTop = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => assignedScrollTop,
    set: (value: number) => {
      assignedScrollTop = value;
    },
  });
  return {
    get assignedScrollTop() {
      return assignedScrollTop;
    },
    setAssignedScrollTop(value: number) {
      assignedScrollTop = value;
    },
    restore() {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) {
          Object.defineProperty(HTMLElement.prototype, key, descriptor);
        } else {
          delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
        }
      }
    },
  };
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

  it("does not show the preview rail trigger when there are no artifacts", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await waitFor(() => {
      expect(container.textContent).toContain("LVIS 에이전트가 준비되었습니다");
    });
    expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-preview-rail"]')).toBeNull();
  });

  it("keeps the message queue test hook closed when LVIS_E2E is set without dev mode", async () => {
    delete (window as unknown as { __lvis_message_queue_store__?: unknown }).__lvis_message_queue_store__;
    await renderApp({ hasApiKey: true, lvisEnv: { isDev: false, isE2E: true } });

    expect((window as unknown as { __lvis_message_queue_store__?: unknown }).__lvis_message_queue_store__).toBeUndefined();
  });

  it("exposes the message queue test hook only for dev e2e runtime", async () => {
    delete (window as unknown as { __lvis_message_queue_store__?: unknown }).__lvis_message_queue_store__;
    await renderApp({ hasApiKey: true, lvisEnv: { isDev: true, isE2E: true } });

    await waitFor(() => {
      expect((window as unknown as { __lvis_message_queue_store__?: unknown }).__lvis_message_queue_store__).toBeDefined();
    });
  });

  it("uses the stable scoped chat scroll surface", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await waitFor(() => {
      const scrollRoot = container.querySelector(".lvis-chat-scroll");
      expect(scrollRoot).not.toBeNull();
      expect(scrollRoot?.querySelector("[data-radix-scroll-area-viewport]")).not.toBeNull();
    });
  });

  it("restores chat scroll position after navigating away and back", async () => {
    const scrollMetrics = installDeterministicScrollMetrics();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    try {
      const { container } = await renderApp({
        currentSession: "sess-scroll-restore",
        mainActiveState: {
          mainActiveSessionId: "sess-scroll-restore",
          mainActiveMode: "resume",
          updatedAt: new Date().toISOString(),
        },
        history: {
          sessionId: "sess-scroll-restore",
          messages: [
            { index: 0, role: "user", content: "스크롤 복원 질문" },
            { index: 1, role: "assistant", content: "스크롤 복원 답변" },
          ],
        },
      });

      const viewport = await waitFor(() => {
        expect(container.textContent).toContain("스크롤 복원 답변");
        const el = container.querySelector(".lvis-chat-scroll [data-radix-scroll-area-viewport]");
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });

      await waitFor(() => expect(scrollMetrics.assignedScrollTop).toBe(2400));

      scrollMetrics.setAssignedScrollTop(720);
      await act(async () => {
        fireEvent.scroll(viewport);
      });

      await act(async () => {
        fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
      });
      await waitFor(() =>
        expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
      );

      await act(async () => {
        fireEvent.click(container.querySelector('[data-testid="settings-inline-back"]')!);
      });

      await waitFor(() => {
        expect(container.querySelector(".lvis-chat-scroll [data-radix-scroll-area-viewport]")).not.toBeNull();
        expect(scrollMetrics.assignedScrollTop).toBe(720);
      });
    } finally {
      scrollMetrics.restore();
    }
  });

  it("hides the empty-state hint while suggested replies are visible", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await waitFor(() => {
      expect(container.textContent).toContain("LVIS 에이전트가 준비되었습니다");
    });

    await act(async () => {
      emitChatStream({
        type: "suggested_replies",
        replies: ["다음 작업 진행", "나중에 할게요"],
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="suggested-replies-ghost"]')).not.toBeNull();
      expect(container.textContent).not.toContain("LVIS 에이전트가 준비되었습니다");
      const textarea = container.querySelector('[data-testid="composer-textarea"]') as HTMLTextAreaElement | null;
      expect(textarea?.getAttribute("placeholder")).toBe("");
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

  it("shows permission reviewer progress and clears it when the tool starts", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "규정 찾아줘");
    await act(async () => {
      emitChatStream({
        type: "permission_review",
        reviewStatus: "reviewing",
        name: "internal_kb_query",
        toolCategory: "network",
        source: "plugin",
        groupId: "g-review",
        toolUseId: "t-review",
        displayOrder: 0,
        approvalPurpose: {
          text: "사용자 요청에 따라 규정 찾아줘 작업을 수행합니다.",
          source: "conversation",
          confidence: "sufficient",
        },
      });
    });

    await waitFor(() => {
      const card = container.querySelector('[data-testid="permission-review-status-card"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute("data-status")).toBe("reviewing");
      expect(container.textContent).toContain("권한 검토중...");
    });

    await act(async () => {
      emitChatStream({
        type: "permission_review",
        reviewStatus: "needs_approval",
        name: "internal_kb_query",
        toolCategory: "network",
        source: "plugin",
        groupId: "g-review",
        toolUseId: "t-review",
        displayOrder: 0,
        verdictLevel: "high",
        reason: "external send",
      });
    });

    await waitFor(() => {
      const card = container.querySelector('[data-testid="permission-review-status-card"]');
      expect(card?.getAttribute("data-status")).toBe("needs_approval");
      expect(container.textContent).toContain("승인 필요 · 높은 위험");
      expect(container.textContent).not.toContain("권한 검토중...");
    });

    await act(async () => {
      emitChatStream({
        type: "tool_start",
        name: "internal_kb_query",
        groupId: "g-review",
        toolUseId: "t-review",
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).toBeNull();
    });
  });

  it("keeps a fast auto-approved permission review card visible for a minimum dwell after tool start", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "빠른 자동 승인 확인");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      await act(async () => {
        emitChatStream({
          type: "permission_review",
          reviewStatus: "reviewing",
          name: "safe_tool",
          toolCategory: "read",
          source: "plugin",
          groupId: "g-dwell",
          toolUseId: "t-dwell",
          displayOrder: 0,
          verdictLevel: "low",
        });
      });
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).not.toBeNull();

      await act(async () => {
        emitChatStream({
          type: "permission_review",
          reviewStatus: "auto_approved",
          name: "safe_tool",
          toolCategory: "read",
          source: "plugin",
          groupId: "g-dwell",
          toolUseId: "t-dwell",
          displayOrder: 0,
          verdictLevel: "low",
        });
      });
      expect(container.querySelector('[data-testid="permission-review-status-card"]')?.getAttribute("data-status")).toBe("auto_approved");

      await act(async () => {
        emitChatStream({
          type: "tool_start",
          name: "safe_tool",
          groupId: "g-dwell",
          toolUseId: "t-dwell",
        });
      });

      const card = container.querySelector('[data-testid="permission-review-status-card"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute("data-status")).toBe("auto_approved");
      expect(container.textContent).toContain("safe_tool");

      await act(async () => {
        vi.advanceTimersByTime(699);
      });
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets tool completion own the final state even when the permission review dwell is pending", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "빠른 도구 완료 확인");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    try {
      await act(async () => {
        emitChatStream({
          type: "permission_review",
          reviewStatus: "auto_approved",
          name: "safe_tool",
          toolCategory: "read",
          source: "plugin",
          groupId: "g-dwell-done",
          toolUseId: "t-dwell-done",
          displayOrder: 0,
          verdictLevel: "low",
        });
      });
      expect(container.querySelector('[data-testid="permission-review-status-card"]')?.getAttribute("data-status")).toBe("auto_approved");

      await act(async () => {
        emitChatStream({
          type: "tool_start",
          name: "safe_tool",
          groupId: "g-dwell-done",
          toolUseId: "t-dwell-done",
        });
      });
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).not.toBeNull();

      await act(async () => {
        emitChatStream({
          type: "tool_end",
          name: "safe_tool",
          groupId: "g-dwell-done",
          toolUseId: "t-dwell-done",
          result: "done",
        });
      });

      expect(container.querySelector('[data-testid="permission-review-status-card"]')).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(700);
      });
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears permission reviewer status on stream done without a tool start", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "상태 정리 확인");
    await act(async () => {
      emitChatStream({
        type: "permission_review",
        reviewStatus: "auto_approved",
        name: "safe_tool",
        toolCategory: "write",
        source: "plugin",
        groupId: "g-done",
        toolUseId: "t-done",
        verdictLevel: "low",
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).not.toBeNull();
    });

    await act(async () => {
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).toBeNull();
    });
  });

  it("clears permission reviewer status on stream error", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "오류 정리 확인");
    await act(async () => {
      emitChatStream({
        type: "permission_review",
        reviewStatus: "failed",
        name: "risky_tool",
        toolCategory: "network",
        source: "plugin",
        groupId: "g-error",
        toolUseId: "t-error",
        reason: "reviewer failed",
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).not.toBeNull();
    });

    await act(async () => {
      emitChatStream({ type: "error", error: "reviewer failed" });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="permission-review-status-card"]')).toBeNull();
      expect(container.textContent).toContain("오류: reviewer failed");
    });
  });

  it("updates expanded WorkGroup permission-review fields when status stays unchanged", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "권한 검토 revision 확인");

    await act(async () => {
      emitChatStream({
        type: "permission_review",
        reviewStatus: "needs_approval",
        name: "first_permission_tool",
        toolCategory: "network",
        source: "plugin",
        groupId: "g-review-revision",
        toolUseId: "t-review-revision",
        displayOrder: 0,
        verdictLevel: "medium",
        approvalPurpose: {
          text: "첫 번째 승인 목적",
          source: "conversation",
          confidence: "sufficient",
        },
      });
      emitChatStream({ type: "text_delta", text: "권한 확인 후 답변합니다" });
      emitChatStream({
        type: "assistant_round",
        text: "권한 확인 후 답변합니다",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/작업\s*1단계/);
      expect(container.textContent).toContain("권한 확인 후 답변합니다");
      expect(container.textContent).not.toContain("첫 번째 승인 목적");
    });

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"work-group\"] button")!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("first_permission_tool");
      expect(container.textContent).toContain("플러그인");
      expect(container.textContent).toContain("첫 번째 승인 목적");
    });

    await act(async () => {
      emitChatStream({
        type: "permission_review",
        reviewStatus: "needs_approval",
        name: "second_permission_tool",
        toolCategory: "network",
        source: "builtin",
        groupId: "g-review-revision",
        toolUseId: "t-review-revision",
        displayOrder: 0,
        verdictLevel: "medium",
        approvalPurpose: {
          text: "두 번째 승인 목적",
          source: "conversation",
          confidence: "sufficient",
        },
      });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("second_permission_tool");
      expect(container.textContent).toContain("내장");
      expect(container.textContent).toContain("두 번째 승인 목적");
      expect(container.textContent).not.toContain("first_permission_tool");
      expect(container.textContent).not.toContain("첫 번째 승인 목적");
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

  it("shows the WorkGroup progress immediately after send before model events arrive", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp({ hasApiKey: true });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "바로 진행 상태 확인");

    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="work-group"]')?.textContent).toContain("작업 중...");
    });
    expect(container.querySelectorAll('[data-testid="assistant-message-body"]')).toHaveLength(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("does not render a standalone Thinking assistant body before stream output", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitChatStream } = await renderApp({ hasApiKey: true });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "대기 상태 확인");

    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await act(async () => {
      emitChatStream({ type: "llm_status", phase: "attempt", attempt: 1 });
    });
    const assistantBodies = Array.from(container.querySelectorAll('[data-testid="assistant-message-body"]'));
    expect(assistantBodies).toHaveLength(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("does not send while IME composition is active", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "한" } });
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });

    expect(api.chatSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("한");
  });

  it("collapses pre-final assistant work and tools into one turn WorkGroup", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "일정 확인");
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

  it("updates expanded WorkGroup content when a same-length tool result changes", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "도구 결과 갱신 확인");

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "도구를 확인합니다" });
      emitChatStream({
        type: "assistant_round",
        text: "도구를 확인합니다",
        thought: "",
        stopReason: "tool_use",
        hasToolCalls: true,
      });
      emitChatStream({
        type: "tool_start",
        name: "calendar_list",
        groupId: "g-same-length",
        toolUseId: "t-same-length",
        input: { query: "today" },
        source: "plugin",
        toolCategory: "read",
        pluginId: "meeting",
      });
      emitChatStream({
        type: "tool_end",
        name: "calendar_list",
        groupId: "g-same-length",
        toolUseId: "t-same-length",
        result: "alpha",
        isError: false,
        source: "plugin",
        toolCategory: "read",
        pluginId: "meeting",
        durationMs: 100,
      });
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/작업\s*1단계/);
    });

    const toolButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("calendar list"),
    ) as HTMLButtonElement | undefined;
    expect(toolButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(toolButton!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("alpha");
    });

    await act(async () => {
      emitChatStream({
        type: "tool_end",
        name: "calendar_list",
        groupId: "g-same-length",
        toolUseId: "t-same-length",
        result: "bravo",
        isError: false,
        source: "plugin",
        toolCategory: "read",
        pluginId: "meeting",
        durationMs: 110,
      });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("bravo");
      expect(container.textContent).not.toContain("alpha");
    });
  });

  it("does not carry expanded WorkGroup state across loaded sessions", async () => {
    const now = new Date().toISOString();
    const messagesFor = (toolName: string, resultText: string, finalText: string) => [
      { index: 0, role: "user", content: "작업 흐름 확인" },
      {
        index: 1,
        role: "assistant",
        content: "",
        thought: "세션 전환 작업 계획",
        toolCalls: [{ id: "tool-1", name: toolName, input: { q: "today" } }],
      },
      { index: 2, role: "tool_result", toolUseId: "tool-1", toolName, content: resultText },
      { index: 3, role: "assistant", content: finalText },
    ];

    const { container, api } = await renderApp({
      currentSession: "current-session",
      sessions: [
        { id: "current-session", modifiedAt: now, title: "현재 대화" },
        { id: "other-session", modifiedAt: now, title: "다른 대화" },
      ],
      mainActiveState: {
        mainActiveSessionId: "current-session",
        mainActiveMode: "resume",
        updatedAt: now,
      },
      history: {
        sessionId: "current-session",
        messages: messagesFor("current_session_probe", "current-session-result", "현재 최종"),
      },
      historyBySession: {
        "other-session": {
          messages: messagesFor("other_session_probe", "other-session-result", "다른 최종"),
        },
      },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("현재 최종");
      expect(container.textContent).toMatch(/작업\s*2단계/);
      expect(container.textContent).not.toContain("current session probe");
    });

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"work-group\"] button")!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("current session probe");
    });

    const dayButton = container.querySelector('[data-testid="session-date-navigator"] button') as HTMLButtonElement | null;
    expect(dayButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(dayButton!);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("다른 대화");
    });

    const sessionButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("다른 대화"),
    ) as HTMLButtonElement | undefined;
    expect(sessionButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(sessionButton!);
    });

    await waitFor(() => {
      expect(api.chatSessionHistory).toHaveBeenCalledWith("other-session");
      expect(container.textContent).toContain("다른 최종");
      expect(container.textContent).not.toContain("current session probe");
      expect(container.textContent).not.toContain("other session probe");
    });

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"work-group\"] button")!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("other session probe");
      expect(container.textContent).not.toContain("current session probe");
    });
  });

  it("keeps the preview rail closed by default and opens it without unmounting chat scroll", async () => {
    const now = new Date().toISOString();
    const { container } = await renderApp({
      currentSession: "preview-session",
      mainActiveState: {
        mainActiveSessionId: "preview-session",
        mainActiveMode: "resume",
        updatedAt: now,
      },
      history: {
        sessionId: "preview-session",
        messages: [
          { index: 0, role: "user", content: "프리뷰 확인" },
          {
            index: 1,
            role: "assistant",
            content: "",
            thought: "파일을 읽고 결과를 확인합니다.",
            toolCalls: [
              {
                id: "preview-tool",
                name: "read_file",
                input: { path: "C:\\workspace\\lvis\\report.md" },
              },
            ],
          },
          {
            index: 2,
            role: "tool_result",
            toolUseId: "preview-tool",
            toolName: "read_file",
            content: "# Report\nPreview content",
          },
          { index: 3, role: "assistant", content: "프리뷰 가능한 파일이 있습니다." },
        ],
      },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("프리뷰 가능한 파일이 있습니다.");
      expect(container.querySelector(".lvis-chat-scroll [data-radix-scroll-area-viewport]")).not.toBeNull();
    });

    const openButton = await waitFor(() => {
      const button = container.querySelector('[data-testid="chat-side-panel-toggle"]') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });
    expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-preview-rail"]')).toBeNull();

    await act(async () => {
      fireEvent.click(openButton);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="chat-side-panel"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="chat-preview-rail"]')).not.toBeNull();
      expect(container.querySelector(".lvis-chat-scroll [data-radix-scroll-area-viewport]")).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="chat-view-root"]')?.className).toContain("flex-row");
    expect(container.querySelector('[data-testid="chat-view-root"]')?.className).not.toContain("lg:pr-96");
    expect(container.querySelector('[data-testid="chat-main-column"]')).not.toBeNull();
    const sidePanelClassName = container.querySelector('[data-testid="chat-side-panel"]')?.className ?? "";
    expect(sidePanelClassName).toContain("relative");
    expect(sidePanelClassName).not.toContain("absolute");
    expect(sidePanelClassName).not.toContain("lg:relative");
    const previewCloseButtons = Array.from(container.querySelectorAll('button[aria-label="사이드 패널 닫기"]'));
    expect(previewCloseButtons.some((button) => button.className.includes("absolute inset-0"))).toBe(false);
    // Content-driven tabs: the panel opens EMPTY to the launcher (no default
    // tabs). Opening the file-browser tab from the launcher then shows the file.
    const launcher = container.querySelector('[data-testid="chat-side-panel-launcher"]') as HTMLElement | null;
    expect(launcher).not.toBeNull();
    const fileLauncher = container.querySelector('[data-testid="chat-side-panel-launcher-file-browser"]') as HTMLButtonElement | null;
    expect(fileLauncher).not.toBeNull();
    await act(async () => {
      fireEvent.click(fileLauncher!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("report.md");
    });
    expect(container.querySelector('[data-testid="input-action-bar"]')).not.toBeNull();
  });

  it("shows sub-agents from a loaded past session (derived from agent_spawn entries) in the viewer + inline", async () => {
    const now = new Date().toISOString();
    const { container } = await renderApp({
      currentSession: "subagent-session",
      mainActiveState: {
        mainActiveSessionId: "subagent-session",
        mainActiveMode: "resume",
        updatedAt: now,
      },
      history: {
        sessionId: "subagent-session",
        messages: [
          { index: 0, role: "user", content: "서브에이전트 히스토리 확인" },
          {
            index: 1,
            role: "assistant",
            content: "",
            thought: "검색 서브에이전트를 실행합니다.",
            toolCalls: [
              {
                id: "spawn-tool-1",
                name: "agent_spawn",
                input: { title: "인덱서 조사", instructions: "관련 파일을 찾아줘" },
              },
            ],
          },
          {
            index: 2,
            role: "tool_result",
            toolUseId: "spawn-tool-1",
            toolName: "agent_spawn",
            content: JSON.stringify({ summary: "관련 파일 3개 확인", toolCallCount: 4, turnCount: 2 }),
          },
          { index: 3, role: "assistant", content: "서브에이전트 실행이 완료되었습니다." },
        ],
      },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("서브에이전트 실행이 완료되었습니다.");
    });

    // The loaded session's agent_spawn tool call is derived into a spawn even
    // though the live agent-spawn event stream never replayed. Past-turn
    // WorkGroups start collapsed, so expand it to reveal the inline completion
    // CHIP (PR3: the lightweight inline surface — full transcript lives in the
    // sub-agent tab, not inline) that renders next to its tool group.
    const workGroupToggle = await waitFor(() => {
      const button = container.querySelector('[data-testid="work-group"] button') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(workGroupToggle);
    });
    await waitFor(() => {
      const inlineChips = container.querySelectorAll('[data-testid="sub-agent-spawn-chip"]');
      expect(inlineChips.length).toBeGreaterThan(0);
      expect(container.textContent).toContain("인덱서 조사");
    });

    // Open the workspace rail and its sub-agent tab — the viewer must be
    // NON-empty (previously showed the "no sub-agents" empty state on load).
    const openButton = await waitFor(() => {
      const button = container.querySelector('[data-testid="chat-side-panel-toggle"]') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(openButton);
    });
    const subagentLauncher = await waitFor(() => {
      const button = container.querySelector('[data-testid="chat-side-panel-launcher-subagent"]') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(subagentLauncher!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="chat-side-panel-subagent-viewer"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="chat-side-panel-subagent-empty"]')).toBeNull();
    });
  });

  it("clears draft attachment preview artifacts when switching sessions", async () => {
    const now = new Date().toISOString();
    const { container, api } = await renderApp({
      currentSession: "session-a",
      sessions: [
        { id: "session-a", modifiedAt: now, title: "Session A" },
        { id: "session-b", modifiedAt: now, title: "Session B" },
      ],
      mainActiveState: {
        mainActiveSessionId: "session-a",
        mainActiveMode: "resume",
        updatedAt: now,
      },
      history: {
        sessionId: "session-a",
        messages: [
          { index: 0, role: "user", content: "A 질문" },
          { index: 1, role: "assistant", content: "A 답변" },
        ],
      },
      historyBySession: {
        "session-b": {
          messages: [
            { index: 0, role: "user", content: "B 질문" },
            { index: 1, role: "assistant", content: "B 답변" },
          ],
        },
      },
    });
    const lvis = window.lvis as unknown as {
      attach: {
        openFile: ReturnType<typeof vi.fn>;
        readImage: ReturnType<typeof vi.fn>;
        saveClipboardImage: ReturnType<typeof vi.fn>;
        openExternal: ReturnType<typeof vi.fn>;
      };
    };
    lvis.attach = {
      openFile: vi.fn(async () => ({
        canceled: false,
        rejected: [],
        files: [
          {
            path: "C:\\workspace\\draft-only.md",
            name: "draft-only.md",
            ext: "md",
            bytes: 512,
            isImage: false,
          },
        ],
      })),
      readImage: vi.fn(async () => ({ ok: false, error: "not image" })),
      saveClipboardImage: vi.fn(async () => ({ ok: false })),
      openExternal: vi.fn(async () => ({ ok: true })),
    };

    await waitFor(() => {
      expect(container.textContent).toContain("A 답변");
      expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeNull();
      expect(container.querySelector('[data-testid="chat-preview-rail"]')).toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="iab-attach-button"]')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("[File #1]");
      expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeNull();
      expect(container.querySelector('[data-testid="chat-side-panel-toggle"]')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="chat-side-panel-toggle"]')!);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="chat-preview-rail"]')).not.toBeNull();
    });
    // Content-driven tabs: open the file-browser tab from the launcher to view
    // the draft attachment in the file tree.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="chat-side-panel-launcher-file-browser"]')!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("draft-only.md");
    });

    const loadSessionHandler = await waitFor(() => {
      const calls = (api.window.onLoadSessionInMain as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const handler = calls[0]?.[0] as ((sessionId: string) => Promise<unknown>) | undefined;
      expect(typeof handler).toBe("function");
      return handler!;
    });

    await act(async () => {
      await loadSessionHandler("session-b");
    });

    await waitFor(() => {
      expect(api.chatSessionHistory).toHaveBeenCalledWith("session-b");
      expect(container.textContent).toContain("B 답변");
      expect(container.querySelector('[data-testid="attachment-chip"]')).toBeNull();
      expect(container.querySelector('[data-testid="attachment-chip-collapsed"]')).toBeNull();
      expect(container.querySelector('[data-testid="chat-preview-open"]')).toBeNull();
      expect(container.textContent).not.toContain("draft-only.md");
    });
  });

  it("keeps overlay-import tool and final assistant output in the normal chat flow", async () => {
    const { container, api, emitOverlayShow, emitChatStream } = await renderApp({ hasApiKey: true });
    await act(async () => {
      emitOverlayShow({
        id: "plugin:meeting:trigger-1",
        source: { kind: "plugin", pluginId: "meeting", eventId: "trigger-1" },
        title: "meeting-summary",
        summary: "**회의 요약**\n- 액션 확인",
        running: false,
        primaryActionLabel: "확인하기",
        pendingPrompt:
          '<imported-from-proactive source="overlay:meeting-summary">\n회의 요약을 확인해줘\n</imported-from-proactive>',
        createdAt: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("회의 요약");
      expect(container.querySelector("[data-testid=\"overlay-card-primary-action\"]")).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"overlay-card-primary-action\"]")!);
    });

    await waitFor(() => {
      expect(api.chatSend).toHaveBeenCalledWith(
        expect.stringContaining("회의 요약을 확인해줘"),
        expect.any(Array),
        "plugin-emitted",
        undefined,
        undefined,
      );
      expect(container.textContent).toContain("overlay:meeting-summary");
      expect(container.querySelector("strong")?.textContent).toBe("회의 요약");
    });

    await act(async () => {
      emitChatStream({ type: "tool_start", name: "meeting_transcript", groupId: "g1", toolUseId: "t1" });
      emitChatStream({
        type: "tool_end",
        name: "meeting_transcript",
        groupId: "g1",
        toolUseId: "t1",
        result: "__meeting_transcript__",
        isError: false,
      });
      emitChatStream({ type: "text_delta", text: "후속 안내입니다" });
      emitChatStream({
        type: "assistant_round",
        text: "후속 안내입니다",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      expect(container.textContent).toMatch(/작업\s*1단계/);
      expect(container.textContent).toContain("후속 안내입니다");
      expect(container.textContent).not.toContain("__meeting_transcript__");
    });
  });

  it("treats overlay imports after an existing chat as a separate turn boundary", async () => {
    const { container, api, emitOverlayShow, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "첫 질문");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "첫 최종 답변" });
      emitChatStream({
        type: "assistant_round",
        text: "첫 최종 답변",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({
        type: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 100,
        freshInputTokens: 10,
        tokensOut: 1,
      });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("첫 최종 답변");
      expect(Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("11"),
      )).toBe(true);
    });

    await act(async () => {
      emitOverlayShow({
        id: "plugin:meeting:trigger-after-chat",
        source: { kind: "plugin", pluginId: "meeting", eventId: "trigger-after-chat" },
        title: "meeting-summary",
        summary: "이전 대화 이후 회의 요약",
        running: false,
        primaryActionLabel: "확인하기",
        pendingPrompt:
          '<imported-from-proactive source="overlay:meeting-summary">\n회의 요약을 확인해줘\n</imported-from-proactive>',
        createdAt: new Date().toISOString(),
      });
    });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid=\"overlay-card-primary-action\"]")!);
    });

    await waitFor(() => {
      expect(api.chatSend).toHaveBeenCalledWith(
        expect.stringContaining("회의 요약을 확인해줘"),
        expect.any(Array),
        "plugin-emitted",
        undefined,
        undefined,
      );
      expect(container.textContent).toContain("overlay:meeting-summary");
    });

    await act(async () => {
      emitChatStream({ type: "tool_start", name: "meeting_transcript", groupId: "g1", toolUseId: "t1" });
      emitChatStream({
        type: "tool_end",
        name: "meeting_transcript",
        groupId: "g1",
        toolUseId: "t1",
        result: "__meeting_transcript__",
        isError: false,
      });
      emitChatStream({ type: "text_delta", text: "overlay 최종 답변" });
      emitChatStream({
        type: "assistant_round",
        text: "overlay 최종 답변",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({
        type: "turn_summary",
        turnDurationMs: 2000,
        toolCount: 1,
        cumulativeToolMs: 300,
        tokensIn: 200,
        freshInputTokens: 20,
        tokensOut: 2,
      });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      const assistantBodies = Array.from(container.querySelectorAll('[data-testid="assistant-message-body"]'));
      expect(assistantBodies.some((body) => body.textContent?.includes("첫 최종 답변"))).toBe(true);
      expect(assistantBodies.some((body) => body.textContent?.includes("overlay 최종 답변"))).toBe(true);
      expect(container.querySelectorAll("[data-testid=\"work-group\"]")).toHaveLength(1);
      const tokenLabels = Array.from(container.querySelectorAll("button"))
        .map((button) => button.textContent ?? "")
        .filter((text) => text.includes("🪙"));
      expect(tokenLabels.some((text) => text.includes("11"))).toBe(true);
      expect(tokenLabels.some((text) => text.includes("22"))).toBe(true);
    });
  });

  it("does not reprice legacy turn summaries that lack serving provider metadata", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "legacy summary");
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "legacy answer" });
      emitChatStream({
        type: "assistant_round",
        text: "legacy answer",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({
        type: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 0,
        cumulativeToolMs: 0,
        tokensIn: 100,
        freshInputTokens: 10,
        tokensOut: 1,
      });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("legacy answer");
      const tokenButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("🪙") && button.textContent.includes("11"),
      );
      expect(tokenButton?.getAttribute("aria-disabled")).toBe("true");
    });

    const tokenButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("🪙") && button.textContent.includes("11"),
    );
    expect(tokenButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(tokenButton!);
    });
    expect(container.textContent).not.toMatch(/≈ \$/);
  });

  it("keeps a one-step pre-final assistant round inside WorkGroup", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "추론 확인");
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
    await submitChatMessage(container, "첫 질문");
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
    await submitChatMessage(container, "둘째 질문");
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
    await submitChatMessage(container, "직접 도구 호출");
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
    await submitChatMessage(container, "마크다운 확인");
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

  it("keeps the accepted final assistant visible when a late delta arrives after end_turn", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "서브에이전트 병렬 검증");
    const finalText = "병렬 검증 완료했습니다.\n\n결론만 먼저 말하면 인덱서, 미팅, 아웃룩 모두 확인되었습니다.";

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "먼저 도구를 확인하겠습니다" });
      emitChatStream({
        type: "assistant_round",
        text: "먼저 도구를 확인하겠습니다",
        thought: "",
        stopReason: "tool_use",
        hasToolCalls: true,
      });
      emitChatStream({ type: "tool_start", name: "agent_spawn", groupId: "g1", toolUseId: "t1" });
      emitChatStream({
        type: "tool_end",
        name: "agent_spawn",
        groupId: "g1",
        toolUseId: "t1",
        result: "ok",
        isError: false,
      });
      emitChatStream({ type: "text_delta", text: finalText });
      emitChatStream({
        type: "assistant_round",
        text: finalText,
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({
        type: "assistant_round",
        text: ".",
        thought: "",
        stopReason: "end_turn",
        hasToolCalls: false,
      });
      emitChatStream({ type: "text_delta", text: "." });
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("병렬 검증 완료했습니다.");
      const assistantBodies = Array.from(container.querySelectorAll('[data-testid="assistant-message-body"]'))
        .map((body) => body.textContent ?? "");
      expect(assistantBodies.some((text) => text.includes("병렬 검증 완료했습니다."))).toBe(true);
      expect(assistantBodies.some((text) => text.trim() === ".")).toBe(false);
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
      mainActiveState: {
        mainActiveSessionId: "sess-history",
        mainActiveMode: "resume",
        updatedAt: "2026-05-16T00:00:00.000Z",
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

  it("keeps standalone reasoning collapsed (header only) DURING and after thinking", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await submitChatMessage(container, "생각만 확인");
    await act(async () => {
      emitChatStream({ type: "reasoning_delta", text: "완료되면 접혀야 하는 생각" });
    });

    await waitFor(() => {
      // The thinking header shows while streaming, but the reasoning body stays
      // COLLAPSED (no auto-expand) — it reveals only on user click.
      expect(container.textContent).toContain("생각 중...");
      expect(container.textContent).not.toContain("완료되면 접혀야 하는 생각");
    });

    await act(async () => {
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      // After completion the header reads "생각 완료" and the raw thought stays
      // hidden. The legacy "응답이 비어있습니다." placeholder is not rendered.
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

  it("does not prepend previous-day session history into the active conversation", async () => {
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

    await submitChatMessage(container, "새 질문");

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="session-date-navigator"]')).toHaveLength(1);
      expect(container.querySelector('[data-session-marker-id="old-yesterday"]')).toBeNull();
      expect(container.textContent).not.toContain("이전 질문");
      expect(container.textContent).not.toContain("이전 답변");
    });
  });

  it("loads the exact selected session from the calendar session list", async () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const now = new Date().toISOString();
    const { container, api } = await renderApp({
      currentSession: "current",
      sessions: [
        { id: "current", modifiedAt: now, title: "현재 대화" },
        { id: "other-session", modifiedAt: now, title: "다른 대화" },
      ],
      history: {
        sessionId: "current",
        messages: [],
      },
      historyBySession: {
        "other-session": {
          messages: [
            { index: 0, role: "user", content: "다른 질문" },
            { index: 1, role: "assistant", content: "다른 답변" },
          ],
        },
      },
    });

    const dayButton = container.querySelector('[data-testid="session-date-navigator"] button') as HTMLButtonElement | null;
    expect(dayButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(dayButton!);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("다른 대화");
    });

    const sessionButton = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("다른 대화"),
    ) as HTMLButtonElement | undefined;
    expect(sessionButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(sessionButton!);
    });

    await waitFor(() => {
      expect(api.chatSessionResume).toHaveBeenCalledWith("other-session");
      expect(api.chatSessionHistory).toHaveBeenCalledWith("other-session");
    });
    const scrolledToMarker = scrollSpy.mock.calls.some(([arg]) =>
      typeof arg === "object" &&
      arg !== null &&
      "block" in arg &&
      (arg as ScrollIntoViewOptions).block === "start",
    );
    expect(scrolledToMarker).toBe(false);
  });

  it("auto-continues after branching from a checkpoint when the branch ends with a user turn", async () => {
    const { container, api, emitChatStream } = await renderApp({
      hasApiKey: true,
      currentSession: "sess-source",
      history: {
        sessionId: "sess-source",
        messages: [],
      },
      historyBySession: {
        "sess-branch-1": {
          messages: [
            { index: 0, role: "user", content: "마지막 질문" },
          ],
        },
      },
    });
    api.chatBranchFromCheckpoint.mockResolvedValueOnce({
      newSessionId: "sess-branch-1",
      lastMessageRole: "user",
      shouldAutoContinue: true,
    });

    await act(async () => {
      emitChatStream({
        type: "compact_notice",
        removedMessages: 37,
        freedTokens: 1200,
        trigger: "auto-compact",
        compactNum: 2,
      });
    });

    const forkButton = await waitFor(() => {
      const button = container.querySelector('[data-testid="ck-btn-fork"]') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(forkButton);
    });

    await waitFor(() => {
      expect(api.chatBranchFromCheckpoint).toHaveBeenCalledWith("sess-source", 2);
      expect(api.chatSessionResume).toHaveBeenCalledWith("sess-branch-1");
      expect(api.chatSessionHistory).toHaveBeenCalledWith("sess-branch-1");
      expect(api.chatContinueLastUser).toHaveBeenCalledWith("sess-branch-1");
      expect(api.chatRetryEffort).not.toHaveBeenCalled();
      expect(container.textContent).toContain("마지막 질문");
      expect(container.textContent).toContain("이 지점부터 다시 시작했습니다. 마지막 질문에 대한 답변을 이어서 생성합니다.");
    });
  });

  it("does not create a checkpoint branch while a turn is streaming", async () => {
    const { container, api, emitChatStream } = await renderApp({
      hasApiKey: true,
      currentSession: "sess-source",
      history: {
        sessionId: "sess-source",
        messages: [],
      },
    });

    await act(async () => {
      emitChatStream({
        type: "compact_notice",
        removedMessages: 12,
        freedTokens: 800,
        trigger: "auto-compact",
        compactNum: 3,
      });
      emitChatStream({ type: "text_delta", text: "응답 작성 중" });
    });

    const forkButton = await waitFor(() => {
      const button = container.querySelector('[data-testid="ck-btn-fork"]') as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(forkButton);
    });

    await waitFor(() => {
      expect(api.chatBranchFromCheckpoint).not.toHaveBeenCalled();
      expect(api.chatSessionResume).not.toHaveBeenCalledWith("sess-branch-1");
      expect(container.textContent).toContain("응답이 끝난 뒤 이 시점에서 다시 시작할 수 있습니다");
    });
  });

  it("places bulk-loaded history at the bottom without smooth replay scrolling", async () => {
    const scrollMetrics = installDeterministicScrollMetrics();
    const scrollToSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToSpy,
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    try {
      const { container } = await renderApp({
        mainActiveState: {
          mainActiveSessionId: "sess-default",
          mainActiveMode: "resume",
          updatedAt: new Date().toISOString(),
        },
        history: {
          sessionId: "sess-default",
          messages: [
            { index: 0, role: "user", content: "오래된 질문" },
            { index: 1, role: "assistant", content: "마지막 답변" },
          ],
        },
      });

      await waitFor(() => {
        expect(container.textContent).toContain("마지막 답변");
        expect(scrollMetrics.assignedScrollTop).toBe(2400);
      });
      expect(scrollToSpy).not.toHaveBeenCalled();
    } finally {
      scrollMetrics.restore();
    }
  });

  it("coalesces streaming bottom-follow into one immediate pin without smooth scroll", async () => {
    const scrollMetrics = installDeterministicScrollMetrics();
    const scrollToSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToSpy,
    });
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      rafCallbacks[id - 1] = () => undefined;
    }));

    try {
      const { container, emitChatStream } = await renderApp({ hasApiKey: true });
      await submitChatMessage(container, "긴 답변 줘");
      await act(async () => {
        while (rafCallbacks.length > 0) {
          rafCallbacks.shift()?.(0);
        }
      });
      rafCallbacks.length = 0;
      scrollToSpy.mockClear();
      scrollMetrics.setAssignedScrollTop(1800);

      await act(async () => {
        emitChatStream({ type: "text_delta", text: "첫 문단" });
        emitChatStream({ type: "text_delta", text: "\n\n두 번째 문단이 같은 assistant entry에 추가됩니다." });
      });

      await waitFor(() => expect(container.textContent).toContain("두 번째 문단"));
      expect(rafCallbacks).toHaveLength(1);

      await act(async () => {
        rafCallbacks.shift()?.(0);
      });

      expect(scrollMetrics.assignedScrollTop).toBe(2400);
      expect(scrollToSpy).not.toHaveBeenCalled();
    } finally {
      scrollMetrics.restore();
    }
  });

  it("moves a tool_use assistant round into the active WorkGroup before tool events arrive", async () => {
    const { container, api, emitChatStream } = await renderApp({ hasApiKey: true });
    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "직접 도구 호출");
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
    await submitChatMessage(container, "마크다운 확인");
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
    await submitChatMessage(container, "오늘 일정");
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
      mainActiveState: {
        mainActiveSessionId: "sess-work-order",
        mainActiveMode: "resume",
        updatedAt: "2026-05-16T00:00:00.000Z",
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
      mainActiveState: {
        mainActiveSessionId: "sess-search-rings",
        mainActiveMode: "resume",
        updatedAt: "2026-05-16T00:00:00.000Z",
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

    expect(finalRingWrapper?.className).toContain("ring-1 ring-primary/(--opacity-medium)");
  });

});

describe("ChatView — userApprovalHit disclosure toast (#793 + cluster MAJOR-2/3)", () => {
  type HitCb = (payload: {
    toolName: string;
    scope: "session" | "persistent";
    verdictAtApproval: "low" | "medium" | "high";
  }) => void;

  async function setupWithCallback() {
    const { container, api, unmount } = await renderApp({ hasApiKey: true });
    const onHitMock = api.permission.onUserApprovalHit as unknown as ReturnType<
      typeof vi.fn
    >;
    await waitFor(() => expect(onHitMock).toHaveBeenCalled());
    const fire = onHitMock.mock.calls[0]?.[0] as HitCb;
    expect(typeof fire).toBe("function");
    return { container, unmount, fire };
  }

  it("renders toast on user-approval-hit broadcast with tool name + scope + verdict", async () => {
    const { container, fire } = await setupWithCallback();
    await act(async () => {
      fire({ toolName: "fs_write", scope: "persistent", verdictAtApproval: "low" });
    });
    const toast = await waitFor(() => {
      const el = container.querySelector('[data-testid="user-approval-hit-toast"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toast.textContent).toContain("권한 메모리 적용");
    expect(toast.textContent).toContain("fs_write");
    expect(toast.textContent).toContain("영구");
    expect(toast.textContent).toContain("LOW");
  });

  it("session-scope hits render '세션' label, not '영구'", async () => {
    const { container, fire } = await setupWithCallback();
    await act(async () => {
      fire({ toolName: "bash_run", scope: "session", verdictAtApproval: "medium" });
    });
    const toast = await waitFor(() => {
      const el = container.querySelector('[data-testid="user-approval-hit-toast"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toast.textContent).toContain("세션");
    expect(toast.textContent).not.toContain("영구");
    expect(toast.textContent).toContain("MEDIUM");
  });

  it("verdict-tier tint uses semantic theme tokens (low=success, medium=warning, high=destructive)", async () => {
    const { container, fire } = await setupWithCallback();
    const cases: Array<["low" | "medium" | "high", string]> = [
      ["low", "success"],
      ["medium", "warning"],
      ["high", "destructive"],
    ];
    for (const [verdict, expectedToken] of cases) {
      await act(async () => {
        fire({ toolName: `tool_${verdict}`, scope: "session", verdictAtApproval: verdict });
      });
      const toast = await waitFor(() => {
        const el = container.querySelector(
          `[data-testid="user-approval-hit-toast"][data-verdict="${verdict}"]`,
        );
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
      // Class string uses `hsl(var(--<token>)/...)` form — assert the token
      // name appears (theme system v2 — bundle-invariant, no palette literals).
      expect(
        toast.className,
        `verdict=${verdict} expected token "--${expectedToken}"`,
      ).toContain(`--${expectedToken}`);
    }
  });

  it("HIGH verdict promotes role to 'alert' + aria-live 'assertive' (urgent disclosure)", async () => {
    const { container, fire } = await setupWithCallback();
    await act(async () => {
      fire({ toolName: "fs_write_sensitive", scope: "session", verdictAtApproval: "high" });
    });
    const toast = await waitFor(() => {
      const el = container.querySelector(
        '[data-testid="user-approval-hit-toast"][data-verdict="high"]',
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.getAttribute("aria-live")).toBe("assertive");
  });

  it("non-HIGH stays role='status' + aria-live='polite'", async () => {
    const { container, fire } = await setupWithCallback();
    await act(async () => {
      fire({ toolName: "fs_read", scope: "persistent", verdictAtApproval: "low" });
    });
    const toast = await waitFor(() => {
      const el = container.querySelector('[data-testid="user-approval-hit-toast"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.getAttribute("aria-live")).toBe("polite");
  });

  it("malformed payload dropped via structural guard (security Med-2)", async () => {
    const { container, fire } = await setupWithCallback();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => {
      // verdictAtApproval is null — pre-PR-A4-R3 entry shape or future bug.
      fire({
        toolName: "fs_write",
        scope: "session",
        verdictAtApproval: null as unknown as "low",
      });
    });
    const toast = container.querySelector('[data-testid="user-approval-hit-toast"]');
    expect(toast).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("subsequent hit replaces previous toast (new payload wins)", async () => {
    const { container, fire } = await setupWithCallback();
    await act(async () => {
      fire({ toolName: "first_tool", scope: "session", verdictAtApproval: "low" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("first_tool");
    });
    await act(async () => {
      fire({ toolName: "second_tool", scope: "persistent", verdictAtApproval: "high" });
    });
    await waitFor(() => {
      const el = container.querySelector('[data-testid="user-approval-hit-toast"]');
      expect(el).not.toBeNull();
      expect(el!.textContent).toContain("second_tool");
      expect(el!.textContent).not.toContain("first_tool");
    });
  });

  it("unmount mid-toast cancels dismiss timer without setState-after-unmount", async () => {
    const { fire, unmount } = await setupWithCallback();
    await act(async () => {
      fire({ toolName: "fs_write", scope: "session", verdictAtApproval: "medium" });
    });
    // Unmount BEFORE the 4s dismiss timer would fire. If cleanup is broken
    // a setState-after-unmount warning would be emitted; otherwise silent.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unmount();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("ChatView — permission review suggestion toast", () => {
  type SuggestionCb = (payload: {
    reason: "allow-always" | "repeat-allow";
    allowCount: number;
    allowAlwaysCount: number;
    threshold: number;
    windowMs: number;
  }) => void;

  it("renders the suggestion and switches through the existing permission APIs", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onSuggestionMock = api.permission.onReviewSuggestion as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(onSuggestionMock).toHaveBeenCalled());
    const fire = onSuggestionMock.mock.calls[0]?.[0] as SuggestionCb;

    await act(async () => {
      fire({
        reason: "repeat-allow",
        allowCount: 3,
        allowAlwaysCount: 0,
        threshold: 3,
        windowMs: 300000,
      });
    });

    const toast = await waitFor(() => {
      const el = container.querySelector('[data-testid="permission-review-suggestion-toast"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(toast.textContent).toContain("LLM 권한 검증으로 전환");
    expect(toast.textContent).toContain("5분 안에 3회 승인했습니다.");

    const button = Array.from(toast.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("전환"),
    ) as HTMLButtonElement | undefined;
    expect(button).toBeDefined();
    await act(async () => {
      fireEvent.click(button!);
    });

    await waitFor(() => {
      expect(api.permission.setMode).toHaveBeenCalledWith("auto");
      expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("mode llm");
      expect(api.permission.reviewerDispatch).toHaveBeenCalledWith("interactive low");
    });
    expect(api.permission.reviewerDispatch).toHaveBeenNthCalledWith(1, "mode llm");
    expect(api.permission.reviewerDispatch).toHaveBeenNthCalledWith(2, "interactive low");
    const reviewerDispatchOrder =
      (api.permission.reviewerDispatch as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const setModeOrder =
      (api.permission.setMode as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    expect(reviewerDispatchOrder[1]).toBeLessThan(setModeOrder[0]);
  });

  it("drops malformed permission review suggestion metrics", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onSuggestionMock = api.permission.onReviewSuggestion as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(onSuggestionMock).toHaveBeenCalled());
    const fire = onSuggestionMock.mock.calls[0]?.[0] as SuggestionCb;

    await act(async () => {
      fire({
        reason: "repeat-allow",
        allowCount: Number.NaN,
        allowAlwaysCount: 0,
        threshold: 3,
        windowMs: 300000,
      });
    });

    expect(container.querySelector('[data-testid="permission-review-suggestion-toast"]')).toBeNull();
  });
});

afterEach(() => {
  __resetSuggestedRepliesStoreForTests();
  __teardownSuggestedRepliesIpcForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
