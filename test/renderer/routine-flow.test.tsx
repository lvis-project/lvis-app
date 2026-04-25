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
    const routineResult = makeRoutineResult();
    const { container } = await renderApp({ latestRoutineResult: routineResult });
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

  it("snooze trigger button is rendered with the new label", async () => {
    // The dropdown menu pop-open + item-click flow is exercised at the hook
    // level (src/ui/renderer/hooks/__tests__/use-routine-result.test.ts) where
    // we can drive timers without Radix portal/pointer-event friction.
    // Here we only assert that the trigger exists with the redesigned label.
    const { container, emitRoutineCompleted } = await renderApp();
    await act(async () => {
      emitRoutineCompleted(makeRoutineResult());
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="routine-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });
    const trigger = card.querySelector('[data-testid="routine-card-snooze-trigger"]');
    expect(trigger).toBeTruthy();
    expect(trigger?.textContent).toContain("나중에 다시");
  });

  it("stacks results with distinct routineIds and shows the index indicator", async () => {
    const { container, emitRoutineCompleted } = await renderApp();
    await act(async () => {
      emitRoutineCompleted({ ...makeRoutineResult(), routineId: "wakeup", summary: "morning" });
    });
    await act(async () => {
      emitRoutineCompleted({ ...makeRoutineResult(), routineId: "schedule-1", trigger: "schedule", summary: "midday" });
    });

    await waitFor(() => {
      const indicator = container.querySelector('[data-testid="routine-card-indicator"]');
      expect(indicator?.textContent).toBe("2/2");
      expect(container.textContent).toContain("midday");
    });
  });

  it("in-place updates a card when the same routineId arrives again", async () => {
    const { container, emitRoutineCompleted } = await renderApp();
    await act(async () => {
      emitRoutineCompleted({ ...makeRoutineResult(), summary: "v1" });
    });
    await waitFor(() => expect(container.textContent).toContain("v1"));
    await act(async () => {
      emitRoutineCompleted({ ...makeRoutineResult(), summary: "v2" });
    });
    await waitFor(() => {
      expect(container.textContent).toContain("v2");
      expect(container.textContent).not.toContain("v1");
      // Single card → no indicator rendered.
      expect(container.querySelector('[data-testid="routine-card-indicator"]')).toBeFalsy();
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
