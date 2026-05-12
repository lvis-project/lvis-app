/**
 * Phase 1 renderer split — App smoke tests.
 *
 * These prove the test infrastructure (jsdom + RTL + mock lvisApi) works
 * end-to-end so Phase 2-4 hook extractions have a safety net.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";

describe("App smoke (Phase 1 infra)", () => {
  it("renders App without crash", async () => {
    const { container, api } = await renderApp();
    expect(container).toBeTruthy();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  });

  it("subscribes to onChatStream on mount", async () => {
    const { api } = await renderApp();
    await waitFor(() => expect(api.onChatStream).toHaveBeenCalled());
  });

  it("receives stream events via emitChatStream without throwing", async () => {
    const { emitChatStream } = await renderApp();
    await act(async () => {
      emitChatStream({ type: "text", text: "hello" });
    });
    expect(true).toBe(true);
  });

  it("OverlayCard appears when onRoutineFiredV2 fires", async () => {
    const { container, emitRoutineFiredV2 } = await renderApp();
    await act(async () => {
      emitRoutineFiredV2({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt: new Date().toISOString(),
        title: "Daily schedule",
        summary: "smoke summary",
      });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
    });
  });

  it("Ctrl+F keydown opens unified search with fresh sessions and starred data", async () => {
    const { api } = await renderApp();
    await waitFor(() => expect(api.chatSessions).toHaveBeenCalled());
    api.chatSessions.mockClear();
    api.starredList.mockClear();
    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    });
    await waitFor(() => expect(api.chatSessions).toHaveBeenCalledTimes(1));
    expect(api.starredList).toHaveBeenCalledTimes(1);
  });

  it("opens the native settings window from the API key prompt", async () => {
    const { container, api } = await renderApp({ hasApiKey: false });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toContain("API 키 설정 필요"));
    const settingsButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("설정 열기"),
    );
    expect(settingsButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(settingsButton!);
    });

    await waitFor(() => expect(api.openSettingsWindow).toHaveBeenCalledWith("llm"));
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it("addStarred / listStarred mock surface is spy-able", async () => {
    const { api } = await renderApp();
    const entry = { messageIndex: 3, role: "assistant", text: "hi", sessionId: "s1" };
    await api.addStarred(entry);
    expect(api.addStarred).toHaveBeenCalledWith(entry);
    const list = await api.listStarred();
    expect(Array.isArray(list)).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
