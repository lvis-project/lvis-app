/**
 * Phase 3.3 safety net — routine result card lifecycle.
 *
 * onRoutineFiredV2 delivery + dismiss IPC. Snooze IPC was removed in PR
 * #626 (Routine v2) — see OverlayCard.tsx comment. Also covers result-view
 * action wiring for routine results with session ids.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { deferred, submitChatMessage } from "./helpers.js";

function makeRoutineResult() {
  return {
    id: "schedule-daily",
    trigger: "schedule",
    firedAt: new Date().toISOString(),
    title: "Daily schedule",
    summary: "daily summary",
  };
}


describe("Routine flow (Phase 3.3 regression net)", () => {
  it("onRoutineFiredV2 renders the OverlayCard", async () => {
    const { container, emitRoutineFiredV2 } = await renderApp();
    await act(async () => {
      emitRoutineFiredV2(makeRoutineResult());
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

  it("rehydrates an unacknowledged routine result on mount after restart", async () => {
    const routineResult = {
      ...makeRoutineResult(),
      routineSessionId: "routine-session-1",
    };
    const { container, api } = await renderApp({ pendingRoutineResults: [routineResult] });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
      expect(container.textContent).toContain("daily summary");
      expect(container.textContent).toContain("결과 보기");
    });
    const primary = container.querySelector('[data-testid="overlay-card-primary-action"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(primary);
    });
    await waitFor(() => {
      expect(api.acknowledgeRoutineResultV2).toHaveBeenCalledWith(routineResult.id, routineResult.firedAt);
    });
  });

  it("does not let a delayed replay overwrite a newer live result", async () => {
    let resolveLatest: ((value: unknown) => void) | null = null;
    const stale = { ...makeRoutineResult(), firedAt: new Date(Date.now() - 10_000).toISOString(), summary: "stale summary" };
    const fresh = { ...makeRoutineResult(), summary: "fresh summary" };
    const { container, emitRoutineFiredV2 } = await renderApp({
      latestRoutineResult: new Promise((resolve) => {
        resolveLatest = resolve;
      }),
    });

    await act(async () => {
      emitRoutineFiredV2(fresh);
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
    const { container, emitRoutineFiredV2 } = await renderApp();
    await act(async () => {
      emitRoutineFiredV2(makeRoutineResult());
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

  // Snooze was removed from RoutineV2 in PR #626 ("production smoke test:
  // UX risk" — see comment in OverlayContext.tsx and OverlayCard.tsx). The
  // previous "snooze trigger button is rendered with the new label" test
  // pointed at a `routine-card-snooze-trigger` data-testid that no longer
  // exists; deleting the orphan rather than leaving it to fail every run.
  it("renders the result-view action for routines with a session id", async () => {
    const { container, api, emitRoutineFiredV2 } = await renderApp();
    await act(async () => {
      emitRoutineFiredV2({
        ...makeRoutineResult(),
        routineSessionId: "routine-session-1",
      });
    });
    const card = await waitFor(() => {
      const el = container.querySelector('[data-testid="routine-card"]');
      if (!el) throw new Error("card not rendered");
      return el;
    });
    expect(card.querySelector('[data-testid="routine-card-snooze-trigger"]')).toBeFalsy();
    const primary = card.querySelector('[data-testid="overlay-card-primary-action"]');
    expect(primary).toBeTruthy();
    expect(primary?.textContent).toContain("결과 보기");

    await act(async () => {
      fireEvent.click(primary!);
    });

    await waitFor(() => {
      expect(api.chatSessionResume).toHaveBeenCalledWith("routine-session-1");
      expect(api.chatSessionHistory).toHaveBeenCalledWith("routine-session-1");
    });
    await waitFor(() => {
      expect(api.acknowledgeRoutineResultV2).toHaveBeenCalledWith("schedule-daily", expect.any(String));
      expect(container.querySelector('[data-testid="routine-card"]')).toBeFalsy();
    });
    expect(api.listRoutineSessionsV2).not.toHaveBeenCalled();
  });

  it("does not acknowledge or dismiss a routine result when opening its session fails", async () => {
    const { container, api, emitRoutineFiredV2 } = await renderApp();
    api.chatSessionResume.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
    });
    await act(async () => {
      emitRoutineFiredV2({
        ...makeRoutineResult(),
        routineSessionId: "missing-routine-session",
      });
    });
    const primary = await waitFor(() => {
      const el = container.querySelector('[data-testid="overlay-card-primary-action"]');
      if (!el) throw new Error("primary action not rendered");
      return el;
    });

    await act(async () => {
      fireEvent.click(primary);
      await Promise.resolve();
    });

    expect(api.chatSessionResume).toHaveBeenCalledWith("missing-routine-session");
    expect(api.chatSessionHistory).not.toHaveBeenCalledWith("missing-routine-session");
    expect(api.acknowledgeRoutineResultV2).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="routine-card"]')).toBeTruthy();
  });

  it("does not open or acknowledge a routine session while the active chat is streaming", async () => {
    const { container, api, emitRoutineFiredV2 } = await renderApp();
    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "진행 중인 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitRoutineFiredV2({
        ...makeRoutineResult(),
        routineSessionId: "routine-session-1",
      });
    });
    const primary = await waitFor(() => {
      const el = container.querySelector('[data-testid="overlay-card-primary-action"]');
      if (!el) throw new Error("primary action not rendered");
      return el;
    });

    await act(async () => {
      fireEvent.click(primary);
      await Promise.resolve();
    });

    expect(api.chatSessionResume).not.toHaveBeenCalledWith("routine-session-1");
    expect(api.chatSessionHistory).not.toHaveBeenCalledWith("routine-session-1");
    expect(api.acknowledgeRoutineResultV2).not.toHaveBeenCalled();

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("stacks results with distinct routineIds and shows the index indicator", async () => {
    const { container, emitRoutineFiredV2 } = await renderApp();
    await act(async () => {
      emitRoutineFiredV2({ ...makeRoutineResult(), id: "wakeup", summary: "morning" });
    });
    await act(async () => {
      emitRoutineFiredV2({ ...makeRoutineResult(), id: "schedule-1", trigger: "schedule", summary: "midday" });
    });

    await waitFor(() => {
      const indicator = container.querySelector('[data-testid="routine-card-indicator"]');
      expect(indicator?.textContent).toBe("2/2");
      expect(container.textContent).toContain("midday");
    });
  });

  it("in-place updates a card when the same routineId arrives again", async () => {
    const { container, emitRoutineFiredV2 } = await renderApp();
    await act(async () => {
      emitRoutineFiredV2({ ...makeRoutineResult(), summary: "v1" });
    });
    await waitFor(() => expect(container.textContent).toContain("v1"));
    await act(async () => {
      emitRoutineFiredV2({ ...makeRoutineResult(), summary: "v2" });
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
