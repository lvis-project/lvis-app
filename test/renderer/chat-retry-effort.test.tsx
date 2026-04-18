/**
 * Phase 3.2 safety net — retry (high-effort) on assistant messages.
 *
 * Verifies chatRetryEffort IPC is called with the thinking budget, that
 * previous entries are restored on failure, and that on success the
 * streaming path replaces the prior assistant entry.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";

async function seedAssistantEntry(
  container: HTMLElement,
  api: ReturnType<typeof vi.fn> | Record<string, ReturnType<typeof vi.fn>>,
  emit: (ev: unknown) => void,
): Promise<void> {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "hi" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
  });
  await waitFor(() => expect((api as any).chatSend).toHaveBeenCalled());
  await act(async () => {
    emit({ type: "text_delta", text: "Hello from LVIS" });
    emit({ type: "assistant_round", text: "Hello from LVIS" });
    emit({ type: "done" });
  });
}

describe("Chat retry (Phase 3.2 regression net)", () => {
  it("retry button calls chatRetryEffort with thinking enabled", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await seedAssistantEntry(container, api, emitChatStream);

    const retryBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="다시 시도 (깊이: high)"]');
      if (!btn) throw new Error("retry button not found");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    await waitFor(() => expect(api.chatRetryEffort).toHaveBeenCalled());
    const arg = api.chatRetryEffort.mock.calls[0]?.[0] as {
      enableThinking?: boolean;
      thinkingBudgetTokens?: number;
    };
    expect(arg?.enableThinking).toBe(true);
    expect(arg?.thinkingBudgetTokens).toBe(20000);
  });

  it("retry success lets new streaming replace the old assistant text", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await seedAssistantEntry(container, api, emitChatStream);

    const retryBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="다시 시도 (깊이: high)"]');
      if (!btn) throw new Error("retry button not found");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    await waitFor(() => expect(api.chatRetryEffort).toHaveBeenCalled());
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "Retried response" });
      emitChatStream({ type: "assistant_round", text: "Retried response" });
      emitChatStream({ type: "done" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Retried response");
    });
  });

  it("retry failure restores the previous entries and shows an error", async () => {
    const { container, api, emitChatStream } = await renderApp();
    api.chatRetryEffort.mockResolvedValueOnce({ ok: false, error: "rate-limited" });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await seedAssistantEntry(container, api, emitChatStream);

    const retryBtn = await waitFor(() => {
      const btn = container.querySelector('button[title="다시 시도 (깊이: high)"]');
      if (!btn) throw new Error("retry button not found");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    await waitFor(() => expect(api.chatRetryEffort).toHaveBeenCalled());
    await waitFor(() => {
      // Prior assistant text remains visible and the failure is surfaced.
      expect(container.textContent).toContain("Hello from LVIS");
      expect(container.textContent).toMatch(/재시도 실패|rate-limited/);
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
