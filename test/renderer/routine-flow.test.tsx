/**
 * Phase 3.3 safety net — routine result card lifecycle.
 *
 * onRoutineCompleted delivery, dismiss IPC, snooze IPC.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";

function makeRoutineResult() {
  return {
    routineId: "wakeup",
    trigger: "wakeup",
    generatedAt: new Date().toISOString(),
    summary: "daily summary",
  };
}

describe("Routine flow (Phase 3.3 regression net)", () => {
  it("onRoutineCompleted renders the RoutineCard", async () => {
    const { container, emitRoutineCompleted } = await renderApp();
    await act(async () => {
      emitRoutineCompleted(makeRoutineResult());
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
    });
  });

  it("replays the latest result on mount when one was already generated", async () => {
    const briefing = makeRoutineResult();
    const { container } = await renderApp({ latestRoutineResult: briefing });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
    });
  });

  it("does not let a delayed replay overwrite a newer live result", async () => {
    let resolveLatest: ((value: unknown) => void) | null = null;
    const stale = { ...makeRoutineResult(), summary: "stale summary" };
    const fresh = { ...makeRoutineResult(), summary: "fresh summary" };
    const { container, emitRoutineCompleted } = await renderApp({
      latestRoutineResult: new Promise((resolve) => {
        resolveLatest = resolve;
      }),
    });

    await act(async () => {
      emitRoutineCompleted(fresh);
    });
    await act(async () => {
      resolveLatest?.(stale);
    });

    await waitFor(() => {
      expect(container.textContent).toContain("fresh summary");
      expect(container.textContent).not.toContain("stale summary");
    });
  });

  it("clicking dismiss removes the card", async () => {
    const { container, emitRoutineCompleted } = await renderApp();
    await act(async () => {
      emitRoutineCompleted(makeRoutineResult());
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="routine-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });

    // Click the 닫기 button to dismiss the routine card.
    const closeBtn = Array.from(card.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "닫기",
    ) as HTMLButtonElement | undefined;
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(closeBtn!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeFalsy();
    });
  });

  it("clicking snooze removes the card", async () => {
    const { container, emitRoutineCompleted } = await renderApp();
    await act(async () => {
      emitRoutineCompleted(makeRoutineResult());
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="routine-card"]');
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
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeFalsy();
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
