// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, act } from "@testing-library/react";
import { TriggerCard } from "../TriggerCard.js";
import type { TriggerResult } from "../../hooks/use-trigger-result.js";

const baseResult: TriggerResult = {
  sessionId: "s1",
  pluginId: "work-proactive",
  source: "proactive:meeting-detection",
  visibility: "user-visible",
  priority: "normal",
  prompt: "p",
  summary: "summary body",
  completedAt: "2026-04-26T00:00:00.000Z",
};

describe("TriggerCard — P2 visibility branching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("user-visible: renders centered variant, no auto-dismiss timer", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <TriggerCard
        result={baseResult}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    expect(getByTestId("trigger-card").getAttribute("data-variant")).toBe("centered");
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("summary-only: auto-dismisses after 8s", () => {
    const onDismiss = vi.fn();
    render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledWith("s1");
  });

  it("summary-only: hover pauses the timer; mouseleave restarts a fresh window", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    const card = getByTestId("trigger-card");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    fireEvent.mouseEnter(card);
    // Hover pause: timer fully drained — no rearm leaked.
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(card);
    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledWith("s1");
  });

  it("summary-only: keyboard focus pauses the timer (a11y parity with hover)", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    const card = getByTestId("trigger-card");
    fireEvent.focus(card);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.blur(card);
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(onDismiss).toHaveBeenCalledWith("s1");
  });

  it("summary-only: a non-stable onDismiss does NOT reset the auto-dismiss window", () => {
    // Regression: if onDismiss is in the effect dep array, every parent
    // render arms a fresh 8s timer and the toast never expires while the
    // user types in chat. Effect must only depend on isSummary, accepting,
    // sessionId — onDismiss flows through a ref.
    const onDismissA = vi.fn();
    const onDismissB = vi.fn();
    const { rerender } = render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={onDismissA}
        onAccept={async () => ({ ok: true })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={onDismissB}
        onAccept={async () => ({ ok: true })}
      />,
    );
    // Should fire at the original 8s mark, NOT 13s (5 + 8).
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(onDismissB).toHaveBeenCalledWith("s1");
    expect(onDismissA).not.toHaveBeenCalled();
  });

  it("summary-only: accept-in-flight pauses the timer (no auto-dismiss while awaiting)", () => {
    // onAccept that never resolves — locks the component in `accepting=true`
    // and proves the timer is gated on it. Rearm-after-resolve is a
    // direct consequence of the effect dep on `accepting`; covered by the
    // hover-pause→mouseleave test which exercises the same rearm path.
    const onAccept = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={onDismiss}
        onAccept={onAccept}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    fireEvent.click(getByTestId("trigger-accept"));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("summary-only: data-variant attribute is 'summary' and aria-live is set", () => {
    const { getByTestId } = render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={vi.fn()}
        onAccept={async () => ({ ok: true })}
      />,
    );
    const card = getByTestId("trigger-card");
    expect(card.getAttribute("data-variant")).toBe("summary");
    expect(card.getAttribute("role")).toBe("status");
    expect(card.getAttribute("aria-live")).toBe("polite");
  });

  it("dismiss button works for both variants (test-id, not text)", () => {
    const onDismiss = vi.fn();
    const { getByTestId, rerender } = render(
      <TriggerCard
        result={baseResult}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    fireEvent.click(getByTestId("trigger-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("s1");

    onDismiss.mockClear();
    rerender(
      <TriggerCard
        result={{ ...baseResult, sessionId: "s2", visibility: "summary-only" }}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    fireEvent.click(getByTestId("trigger-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("s2");
  });
});
