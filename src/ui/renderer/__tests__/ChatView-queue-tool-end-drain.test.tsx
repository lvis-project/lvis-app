/**
 * The mid-turn queue hand-off must be CONFIRMED, not optimistic.
 *
 * `use-message-queue` treats every `tool_end` as a brake point. It used to do:
 *
 *     const taken = messageQueueStore.takeAll();   // synchronous, optimistic
 *     void (async () => { await onGuide(...) })(); // fire-and-forget
 *
 * so the panel emptied on the first tool that finished — mid-turn, not at turn
 * end — and the removal was committed before `onGuide` had said whether the
 * engine accepted the text. A refusal therefore destroyed what the user typed.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { deferred, submitChatMessage } from "../../../../test/renderer/helpers.js";
import type { MessageQueueStore } from "../state/message-queue-store.js";

function getQueueStore(): MessageQueueStore | undefined {
  return (window as unknown as { __lvis_message_queue_store__?: MessageQueueStore })
    .__lvis_message_queue_store__;
}

async function queueOneWhileStreaming() {
  const pendingSend = deferred<{ ok: true }>();
  const harness = await renderApp({
    hasApiKey: true,
    lvisEnv: { isDev: true, isE2E: true },
  });
  harness.api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
  await submitChatMessage(harness.container, "첫 질문");
  await waitFor(() => expect(harness.api.chatSend).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(getQueueStore()).toBeDefined());

  await submitChatMessage(harness.container, "대기 중 추가 요청");
  await waitFor(() => expect(getQueueStore()!.size()).toBe(1));
  return { ...harness, pendingSend };
}

describe("message queue — mid-turn tool_end drain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { __lvis_message_queue_store__?: unknown }).__lvis_message_queue_store__;
  });

  it("clears the queue only once the engine has accepted the hand-off", async () => {
    const guide = deferred<{ ok: true }>();
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();
    api.chatGuide.mockImplementationOnce(async () => guide.promise);

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));

    // Hand-off in flight, not yet confirmed → the item is still the user's.
    expect(getQueueStore()!.size()).toBe(1);

    await act(async () => {
      guide.resolve({ ok: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(getQueueStore()!.size()).toBe(0));

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("keeps the queued text when the engine refuses the hand-off", async () => {
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();

    // The engine clears its abort controller in the turn's `finally`, so a
    // brake point that lands in that window is answered "no-active-turn".
    api.chatGuide.mockImplementationOnce(async () => ({ ok: false, error: "no-active-turn" }));

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));

    // Nothing was taken optimistically, so the text the user typed survives.
    expect(getQueueStore()!.size()).toBe(1);

    // Further brake points in the SAME turn do not retry — one toast, not one
    // per tool.
    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t2", name: "read_file", result: "ok" });
      emitChatStream({ type: "tool_end", toolUseId: "t3", name: "read_file", result: "ok" });
    });
    expect(api.chatGuide).toHaveBeenCalledTimes(1);

    // The turn ends → the survivors go out as a fresh turn.
    await act(async () => {
      emitChatStream({ type: "done" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));
    expect(api.chatSend.mock.calls[1][0]).toContain("대기 중 추가 요청");
    expect(getQueueStore()!.size()).toBe(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("does not send the same items twice when tool_end events burst", async () => {
    const guide = deferred<{ ok: true }>();
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();
    api.chatGuide.mockImplementationOnce(async () => guide.promise);

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
      emitChatStream({ type: "tool_end", toolUseId: "t2", name: "read_file", result: "ok" });
      emitChatStream({ type: "tool_end", toolUseId: "t3", name: "read_file", result: "ok" });
    });

    // Items now survive the first attempt, so without the in-flight guard the
    // later brake points would hand the SAME text over again.
    expect(api.chatGuide).toHaveBeenCalledTimes(1);

    await act(async () => {
      guide.resolve({ ok: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(getQueueStore()!.size()).toBe(0));

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });
});
