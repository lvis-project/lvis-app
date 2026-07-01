import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";

describe("App notification toasts", () => {
  const originalGlobalResizeObserver = globalThis.ResizeObserver;
  const originalWindowResizeObserver = window.ResizeObserver;

  beforeEach(() => {
    class TestResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalGlobalResizeObserver,
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: originalWindowResizeObserver,
    });
    vi.restoreAllMocks();
  });

  it("routes the Learn more action through notifyClick and dismisses the toast", async () => {
    const user = userEvent.setup();
    const { api, emitNotificationToast } = await renderApp();

    emitNotificationToast({
      kind: "ask-user",
      title: "질문",
      body: "진행해도 될까요?",
      contextRef: { questionId: "q-1" },
    });

    await user.click(await screen.findByRole("button", { name: /자세히 알아보기|Learn more/ }));

    expect(api.notifyClick).toHaveBeenCalledWith({
      kind: "ask-user",
      contextRef: { questionId: "q-1" },
    });
    await waitFor(() => {
      expect(screen.queryByTestId("status-toast-message")).toBeNull();
    });
  });

  it("handles clicked session notifications by loading the referenced chat", async () => {
    const { api, emitNotificationClicked } = await renderApp({
      historyBySession: {
        "sess-target": {
          sessionId: "sess-target",
          sessionTitle: "알림 대상 세션",
          sessionKind: "main",
          messages: [],
        },
      },
    });

    emitNotificationClicked({
      kind: "turn-end",
      contextRef: { sessionId: "sess-target" },
    });

    await waitFor(() => {
      expect(api.chatSessionResume).toHaveBeenCalledWith("sess-target");
    });
  });
});
