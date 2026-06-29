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

  it("opens settings inline (work mode) from the API key prompt", async () => {
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

    // Default appMode is "work" — Settings renders INLINE in the main area
    // (same setActiveView + MainContent path as 업무보드/루틴/메모리/별표), so
    // the detached BrowserWindow IPC must NOT fire and chat must not send.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    expect(container.querySelector('[data-testid="settings-inline-back"]')).toBeTruthy();
    expect(api.openSettingsWindow).not.toHaveBeenCalled();
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

  it("renders a closable right action panel", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    expect(container.querySelector('[data-testid="action-panel"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="action-panel-close"]')!);
    });

    expect(container.querySelector('[data-testid="action-panel"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="action-panel-rail"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="action-panel-open"]')!);
    });

    expect(container.querySelector('[data-testid="action-panel"]')).toBeTruthy();
  });

  it("runs connected actions from the right action panel", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="action-panel-item-settings"]')!);
    });

    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    expect(api.openSettingsWindow).not.toHaveBeenCalled();
  });
});

describe("Settings inline (work mode) vs detached (chat mode)", () => {
  it("renders Settings inline, marks the sidebar item active, and returns home", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const sidebarSettings = container.querySelector(
      '[data-testid="sidebar-settings"]',
    ) as HTMLElement | null;
    expect(sidebarSettings).toBeTruthy();

    await act(async () => {
      fireEvent.click(sidebarSettings!);
    });

    // Inline render via setActiveView + MainContent — never the detached window.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy(),
    );
    expect(api.openSettingsWindow).not.toHaveBeenCalled();
    // Sidebar item shows ACTIVE state (aria-current=page) while inline.
    expect(
      container
        .querySelector('[data-testid="sidebar-settings"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");

    // Re-clicking while already on settings is a no-op (view stays mounted).
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });
    expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeTruthy();

    // Back-to-home affordance returns to the prior/home view.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="settings-inline-back"]')!);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeFalsy(),
    );
  });

  it("detaches Settings to its own window in chat mode (unchanged path)", async () => {
    const { container, api } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="app-mode-chat"]')!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="sidebar-settings"]')!);
    });

    // Chat mode keeps the existing detached BrowserWindow path; nothing renders
    // inline.
    await waitFor(() => expect(api.openSettingsWindow).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="settings-sidebar-heading"]')).toBeFalsy();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
