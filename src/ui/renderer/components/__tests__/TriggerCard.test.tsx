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

  it("user-visible: renders modal variant, no auto-dismiss timer", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(
      <TriggerCard
        result={baseResult}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    expect(getByTestId("trigger-card").getAttribute("data-variant")).toBe("modal");
    // Advance well past the 8s window — modal must NOT auto-dismiss
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
    // 5s in, hover → timer paused
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    fireEvent.mouseEnter(card);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    // mouseleave → fresh 8s window
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

  it("summary-only: data-variant attribute set to 'summary'", () => {
    const { getByTestId } = render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={vi.fn()}
        onAccept={async () => ({ ok: true })}
      />,
    );
    expect(getByTestId("trigger-card").getAttribute("data-variant")).toBe("summary");
  });

  it("dismiss button works for both variants", () => {
    const onDismiss = vi.fn();
    const { getByText, rerender } = render(
      <TriggerCard
        result={baseResult}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    fireEvent.click(getByText("무시"));
    expect(onDismiss).toHaveBeenCalledWith("s1");

    onDismiss.mockClear();
    rerender(
      <TriggerCard
        result={{ ...baseResult, sessionId: "s2", visibility: "summary-only" }}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    fireEvent.click(getByText("무시"));
    expect(onDismiss).toHaveBeenCalledWith("s2");
  });
});
