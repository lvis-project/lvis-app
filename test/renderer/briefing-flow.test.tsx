/**
 * Phase 3.3 safety net — daily briefing card lifecycle.
 *
 * onProactiveBriefing delivery, dismiss IPC, snooze IPC.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";

function makeBriefing() {
  return {
    generatedAt: new Date().toISOString(),
    items: [{ category: "info", priority: "low", title: "Test item" }],
    summary: "daily summary",
  };
}

describe("Briefing flow (Phase 3.3 regression net)", () => {
  it("onProactiveBriefing renders the BriefingCard", async () => {
    const { container, emitProactive } = await renderApp();
    await act(async () => {
      emitProactive(makeBriefing());
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="briefing-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
    });
  });

  it("clicking dismiss calls dismissBriefing and removes the card", async () => {
    const { container, api, emitProactive } = await renderApp();
    await act(async () => {
      emitProactive(makeBriefing());
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="briefing-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });

    // Click the 닫기 button, pick the "건너뛰고 닫기" option to bypass reason picker.
    const closeBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "닫기",
    ) as HTMLButtonElement | undefined;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(closeBtn!);
    });
    const skipBtn = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("건너뛰고 닫기"),
      );
      if (!btn) throw new Error("skip-close not found");
      return btn as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(skipBtn);
    });
    await waitFor(() => expect(api.dismissBriefing).toHaveBeenCalled());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="briefing-card"]')).toBeFalsy();
    });
  });

  it("clicking snooze calls snoozeBriefing and removes the card", async () => {
    const { container, api, emitProactive } = await renderApp();
    await act(async () => {
      emitProactive(makeBriefing());
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="briefing-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });
    const snoozeBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("1시간 뒤 다시"),
    ) as HTMLButtonElement | undefined;
    expect(snoozeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(snoozeBtn!);
    });
    await waitFor(() => expect(api.snoozeBriefing).toHaveBeenCalled());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="briefing-card"]')).toBeFalsy();
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
