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
});

afterEach(() => {
  vi.unstubAllGlobals();
});
