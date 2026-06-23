/**
 * D6 — thumbs up/down feedback on AssistantCard renderer test.
 * Verifies api.submitFeedback is called with the expected payload.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";


describe("D6 AssistantCard feedback buttons", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("thumbs-up click calls submitFeedback with rating=up", async () => {
    const { container, api, emitChatStream } = await renderApp({ currentSession: "sess-fb" });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await submitChatMessage(container, "hello");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    // Emit an assistant response so AssistantCard renders
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "Hi there!" });
      emitChatStream({ type: "done" });
    });

    const thumbsUpBtn = await waitFor(() => {
      const btn = container.querySelector('button[aria-label="도움이 됐어요"]');
      if (!btn) throw new Error("thumbs-up button not found");
      return btn as HTMLButtonElement;
    });

    await act(async () => {
      fireEvent.click(thumbsUpBtn);
    });

    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalled());
    const call = api.submitFeedback.mock.calls[0]?.[0] as {
      sessionId: string;
      messageIndex: number;
      rating: string;
    };
    expect(call.rating).toBe("up");
    expect(call.sessionId).toBe("sess-fb");
    expect(typeof call.messageIndex).toBe("number");
  });

  it("thumbs-down click shows reason box and submits with rating=down", async () => {
    const { container, api, emitChatStream } = await renderApp({ currentSession: "sess-fb2" });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await submitChatMessage(container, "world");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitChatStream({ type: "text_delta", text: "Response text" });
      emitChatStream({ type: "done" });
    });

    const thumbsDownBtn = await waitFor(() => {
      const btn = container.querySelector('button[aria-label="개선이 필요해요"]');
      if (!btn) throw new Error("thumbs-down button not found");
      return btn as HTMLButtonElement;
    });

    await act(async () => {
      fireEvent.click(thumbsDownBtn);
    });

    // Reason input now opens in a Popover portaled to document.body (floats
    // above the 👎 button), so query the whole document, not just `container`.
    const reasonInput = await waitFor(() => {
      const el = document.querySelector('input[placeholder="이유 (선택)"]');
      if (!el) throw new Error("reason input not found");
      return el as HTMLInputElement;
    });

    await act(async () => {
      fireEvent.change(reasonInput, { target: { value: "not accurate" } });
      fireEvent.keyDown(reasonInput, { key: "Enter", code: "Enter" });
    });

    await waitFor(() => expect(api.submitFeedback).toHaveBeenCalled());
    const call = api.submitFeedback.mock.calls[0]?.[0] as {
      rating: string;
      reason?: string;
    };
    expect(call.rating).toBe("down");
    expect(call.reason).toBe("not accurate");
  });
});
