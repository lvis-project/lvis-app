/**
 * Behavior-lock tests for ChatView's mid-turn message queue + ⌘K guide.
 *
 * C13 pre-decomposition lock (C15 will move these composer/keyboard flows into
 * hooks). Captured CURRENT behavior:
 *   - Enter while streaming enqueues (does NOT start a new chatSend); the queue
 *     drains on the stream `done` event via an auto-inject whose inputOrigin is
 *     "queue-auto" (the App handleAsk queue-auto branch, locked transitively).
 *   - ⌘K / Ctrl+K with non-empty composer text calls the guide IPC and clears
 *     the composer on success; empty text is a no-op.
 *
 * Harness conventions copied from ChatView.test.tsx.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { deferred, submitChatMessage } from "../../../../test/renderer/helpers.js";
import type { MessageQueueStore } from "../state/message-queue-store.js";

function getQueueStore(): MessageQueueStore | undefined {
  return (window as unknown as { __lvis_message_queue_store__?: MessageQueueStore })
    .__lvis_message_queue_store__;
}

describe("ChatView message queue (enqueue while streaming → drains after)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { __lvis_message_queue_store__?: unknown }).__lvis_message_queue_store__;
  });

  it("enqueues an Enter submit during streaming (no new chatSend) and drains it as queue-auto on done", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitChatStream } = await renderApp({
      hasApiKey: true,
      // dev+e2e exposes the live message-queue store on window so the enqueue
      // step can be asserted directly against store state.
      lvisEnv: { isDev: true, isE2E: true },
    });

    // First turn: keep chatSend pending so streaming stays true while we type
    // the second message.
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "첫 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="work-group"]')?.textContent).toContain("작업 중...");
    });

    await waitFor(() => expect(getQueueStore()).toBeDefined());

    // Second Enter while streaming → enqueued, NOT sent.
    await submitChatMessage(container, "대기 중 추가 요청");
    await waitFor(() => expect(getQueueStore()!.size()).toBe(1));
    expect(api.chatSend).toHaveBeenCalledTimes(1);

    // Stream done → queue drains as a fresh turn with inputOrigin "queue-auto".
    await act(async () => {
      emitChatStream({ type: "done" });
    });

    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));
    const drainCall = api.chatSend.mock.calls[1];
    expect(drainCall[0]).toContain("대기 중 추가 요청");
    expect(drainCall[2]).toBe("queue-auto");
    // Queue emptied by the drain.
    expect(getQueueStore()!.size()).toBe(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("does not enqueue when idle — an Enter submit sends immediately", async () => {
    const { container, api } = await renderApp({
      hasApiKey: true,
      lvisEnv: { isDev: true, isE2E: true },
    });
    await waitFor(() => expect(getQueueStore()).toBeDefined());

    await submitChatMessage(container, "즉시 전송");

    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    expect(api.chatSend.mock.calls[0][0]).toContain("즉시 전송");
    expect(getQueueStore()!.size()).toBe(0);
  });
});

describe("ChatView ⌘K guide", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the guide IPC with the composer text and clears it on success", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector('[data-testid="composer-textarea"]') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "다음 라운드에서 표를 만들어줘" } });
    });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "k", code: "KeyK", metaKey: true });
    });

    await waitFor(() => {
      expect(api.chatGuide).toHaveBeenCalledWith("다음 라운드에서 표를 만들어줘");
    });
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("is a no-op when the composer is empty (guide IPC not called)", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector('[data-testid="composer-textarea"]') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "k", code: "KeyK", ctrlKey: true });
    });

    // Give any async guide dispatch a tick to (not) happen.
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.chatGuide).not.toHaveBeenCalled();
  });
});
