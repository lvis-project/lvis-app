/**
 * Phase 3.3 safety net — daily briefing card lifecycle.
 *
 * onRoutineBriefing delivery, dismiss IPC, snooze IPC.
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
  it("onRoutineBriefing renders the BriefingCard", async () => {
    const { container, emitRoutineBriefing } = await renderApp();
    await act(async () => {
      emitRoutineBriefing(makeBriefing());
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="briefing-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
    });
  });

  it("replays the latest briefing on mount when one was already generated", async () => {
    const briefing = makeBriefing();
    const { container } = await renderApp({ latestRoutineBriefing: briefing });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="briefing-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
    });
  });

  it("does not let a delayed replay overwrite a newer live briefing", async () => {
    let resolveLatest: ((value: unknown) => void) | null = null;
    const stale = { ...makeBriefing(), summary: "stale summary" };
    const fresh = { ...makeBriefing(), summary: "fresh summary" };
    const { container, emitRoutineBriefing } = await renderApp({
      latestRoutineBriefing: new Promise((resolve) => {
        resolveLatest = resolve;
      }),
    });

    await act(async () => {
      emitRoutineBriefing(fresh);
    });
    await act(async () => {
      resolveLatest?.(stale);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("fresh summary");
      expect(container.textContent).not.toContain("stale summary");
    });
  });

  it("clicking dismiss calls dismissBriefing and removes the card", async () => {
    const { container, api, emitRoutineBriefing } = await renderApp();
    await act(async () => {
      emitRoutineBriefing(makeBriefing());
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="briefing-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });

    // Click the 닫기 button to dismiss the briefing.
    const closeBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "닫기",
    ) as HTMLButtonElement | undefined;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(closeBtn!);
    });
    await waitFor(() => expect(api.dismissBriefing).toHaveBeenCalled());
    await waitFor(() => {
      expect(container.querySelector('[data-testid="briefing-card"]')).toBeFalsy();
    });
  });

  it("clicking snooze calls snoozeBriefing and removes the card", async () => {
    const { container, api, emitRoutineBriefing } = await renderApp();
    await act(async () => {
      emitRoutineBriefing(makeBriefing());
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
