/**
 * Behavior-lock tests for App workspace-mode (appMode) transitions.
 *
 * C13 pre-decomposition lock (C16 will move App shell wiring into hooks). These
 * capture the CURRENT observable behavior of the chat/work segmented control:
 * toggling persists the new mode via updateSettings({ system: { appMode } }) and
 * flips the segment's aria-pressed state. Default mode is "work".
 *
 * The routine-overlay IPC subscriptions are ALREADY covered and are NOT
 * duplicated here:
 *   - onRoutineFiredV2 → OverlayCard renders: test/renderer/routine-flow.test.tsx
 *     ("onRoutineFiredV2 renders the OverlayCard" and siblings).
 *   - onOverlayShow (plugin overlay) → card + primary action → handleAsk
 *     trigger-import: src/ui/renderer/__tests__/ChatView.test.tsx
 *     ("keeps overlay-import tool and final assistant output in the normal chat
 *     flow").
 *
 * Harness conventions copied from AppPluginAuth.test.tsx / ChatView.test.tsx.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";

describe("App workspace mode (appMode) transitions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults to work mode and persists chat/work toggles via updateSettings", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });

    const chatBtn = await waitFor(() => {
      const el = container.querySelector('[data-testid="app-mode-chat"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    const workBtn = container.querySelector('[data-testid="app-mode-work"]') as HTMLButtonElement;
    expect(workBtn).toBeTruthy();

    // Default mode is "work" → work segment pressed, chat segment not.
    expect(workBtn.getAttribute("aria-pressed")).toBe("true");
    expect(chatBtn.getAttribute("aria-pressed")).toBe("false");

    // Toggle to chat → persisted + pressed flips.
    await act(async () => {
      fireEvent.click(chatBtn);
    });
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ system: { appMode: "chat" } });
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="app-mode-chat"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        container.querySelector('[data-testid="app-mode-work"]')?.getAttribute("aria-pressed"),
      ).toBe("false");
    });

    // Toggle back to work → persisted + pressed flips back.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="app-mode-work"]')!);
    });
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ system: { appMode: "work" } });
    });
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="app-mode-work"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        container.querySelector('[data-testid="app-mode-chat"]')?.getAttribute("aria-pressed"),
      ).toBe("false");
    });
  });

  it("does not persist a redundant write when the already-active mode is clicked", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });

    const workBtn = await waitFor(() => {
      const el = container.querySelector('[data-testid="app-mode-work"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    // Default is work; clicking work must not emit an appMode settings write.
    await act(async () => {
      fireEvent.click(workBtn);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const appModeWrites = api.updateSettings.mock.calls.filter(
      ([payload]) =>
        typeof payload === "object" &&
        payload !== null &&
        "system" in (payload as Record<string, unknown>) &&
        typeof (payload as { system?: unknown }).system === "object" &&
        (payload as { system?: { appMode?: unknown } }).system?.appMode !== undefined,
    );
    expect(appModeWrites).toHaveLength(0);
  });
});
