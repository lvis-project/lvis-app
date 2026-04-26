// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

describe("TriggerCard — variant rendering + persistence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("user-visible: data-variant='centered'", () => {
    const { getByTestId } = render(
      <TriggerCard
        result={baseResult}
        onDismiss={vi.fn()}
        onAccept={async () => ({ ok: true })}
      />,
    );
    expect(getByTestId("trigger-card").getAttribute("data-variant")).toBe("centered");
  });

  it("summary-only: data-variant='summary' + role/aria-live for screen readers", () => {
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

  it("toast persists until the user explicitly clicks (no auto-dismiss)", () => {
    // Earlier versions auto-dismissed summary-only toasts after 8s with
    // hover/focus pause. That silently killed proactive notifications
    // when the user clicked outside the app. Toasts are now persistent
    // — explicit user decision (확인하기 or 무시) is required.
    const onDismiss = vi.fn();
    render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={onDismiss}
        onAccept={async () => ({ ok: true })}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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

  it("accept button label switches to 확인 중... while in flight", async () => {
    let resolveAccept: (out: { ok: boolean }) => void = () => {};
    const onAccept = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((r) => {
          resolveAccept = r;
        }),
    );
    const { getByTestId, getByText } = render(
      <TriggerCard
        result={{ ...baseResult, visibility: "summary-only" }}
        onDismiss={vi.fn()}
        onAccept={onAccept}
      />,
    );
    expect(getByText("확인하기")).toBeTruthy();
    fireEvent.click(getByTestId("trigger-accept"));
    expect(getByText("확인 중...")).toBeTruthy();
    await act(async () => {
      resolveAccept({ ok: true });
    });
  });
});
