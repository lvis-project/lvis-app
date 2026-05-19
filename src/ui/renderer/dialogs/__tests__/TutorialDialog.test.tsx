// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TutorialDialog, type TutorialDialogApi } from "../TutorialDialog.js";
import {
  DISCOVERY_CARDS,
  FALLBACK_SCENARIO_ID,
} from "../../onboarding/discovery-cards.js";

function makeApi(overrides: Partial<TutorialDialogApi> = {}): TutorialDialogApi {
  return {
    tutorialRecord: vi.fn(async () => ({ ok: true })),
    tour: { start: vi.fn(async () => ({ ok: true })) },
    ...overrides,
  };
}

function flushAll() {
  return act(() => Promise.resolve());
}

describe("TutorialDialog (Tutorial-D)", () => {
  it("renders the first card with violet ring when opened", () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    expect(screen.getByTestId("tutorial-dialog")).toBeTruthy();
    const top = screen.getByTestId("tutorial-dialog:top-card");
    expect(top.getAttribute("data-card-id")).toBe(DISCOVERY_CARDS[0].id);
    expect(screen.getByTestId("tutorial-dialog:progress").textContent).toBe(
      `1 / ${DISCOVERY_CARDS.length}`,
    );
  });

  it("advances the deck on ✓ and records the liked action", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    fireEvent.click(screen.getByTestId("tutorial-dialog:like"));
    // U9 — swipe-out animation has a 300ms (or 150ms under reduced
    // motion) exit delay before the cursor advances. Fake timers would
    // be heavier here than a real-timer wait — vitest fakeTimers leaks
    // into matchMedia and breaks the reduced-motion hook fallback.
    await act(() => new Promise((r) => setTimeout(r, 320)));
    expect(api.tutorialRecord).toHaveBeenCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "liked",
    });
    const top = screen.getByTestId("tutorial-dialog:top-card");
    expect(top.getAttribute("data-card-id")).toBe(DISCOVERY_CARDS[1].id);
  });

  it("advances the deck on ✕ and records the disliked action", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    fireEvent.click(screen.getByTestId("tutorial-dialog:dislike"));
    await act(() => new Promise((r) => setTimeout(r, 320)));
    expect(api.tutorialRecord).toHaveBeenCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "disliked",
    });
  });

  it("keyboard ↑ likes and ↓ dislikes", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    await act(() => new Promise((r) => setTimeout(r, 320)));
    expect(api.tutorialRecord).toHaveBeenCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "liked",
    });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(() => new Promise((r) => setTimeout(r, 320)));
    expect(api.tutorialRecord).toHaveBeenCalledWith({
      cardId: DISCOVERY_CARDS[1].id,
      action: "disliked",
    });
  });

  it("space skips without recording a like or dislike", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    await flushAll();
    expect(api.tutorialRecord).not.toHaveBeenCalled();
    const top = screen.getByTestId("tutorial-dialog:top-card");
    expect(top.getAttribute("data-card-id")).toBe(DISCOVERY_CARDS[1].id);
  });

  it("undo restores the previous card and records the undone action", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    fireEvent.click(screen.getByTestId("tutorial-dialog:like"));
    await act(() => new Promise((r) => setTimeout(r, 320)));
    fireEvent.click(screen.getByTestId("tutorial-dialog:undo"));
    await flushAll();
    expect(api.tutorialRecord).toHaveBeenLastCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "undone",
    });
    const top = screen.getByTestId("tutorial-dialog:top-card");
    expect(top.getAttribute("data-card-id")).toBe(DISCOVERY_CARDS[0].id);
  });

  it("calls tour.start with the first liked scenario when the user clicks 가이드 시작 (U2)", async () => {
    const api = makeApi();
    const onOpenChange = vi.fn();
    render(<TutorialDialog open onOpenChange={onOpenChange} api={api} />);
    // Card 1 disliked, Card 2 (doc-search) liked, rest skipped.
    fireEvent.click(screen.getByTestId("tutorial-dialog:dislike"));
    await act(() => new Promise((r) => setTimeout(r, 320)));
    fireEvent.click(screen.getByTestId("tutorial-dialog:like"));
    await act(() => new Promise((r) => setTimeout(r, 320)));
    for (let i = 2; i < DISCOVERY_CARDS.length; i += 1) {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
      // eslint-disable-next-line no-await-in-loop
      await flushAll();
    }
    // U2 — the FinishedSummary screen must be visible AND tour.start
    // must NOT have been called yet. Only an explicit click on the
    // "가이드 시작" CTA triggers the spotlight tour.
    expect(screen.getByTestId("tutorial-dialog:finished")).toBeTruthy();
    expect(api.tour.start).not.toHaveBeenCalled();
    // Click the explicit "가이드 시작" CTA.
    fireEvent.click(screen.getByTestId("tutorial-dialog:start"));
    // The handler closes the dialog first, then dispatches the tour
    // after an 80ms portal-unmount delay.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(api.tour.start).toHaveBeenCalledWith(
      DISCOVERY_CARDS[1].spotlightScenarioId,
    );
  });

  it("falls back to first-boot-essentials when the user did not like any card (U2)", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    for (let i = 0; i < DISCOVERY_CARDS.length; i += 1) {
      fireEvent.click(screen.getByTestId("tutorial-dialog:dislike"));
      // eslint-disable-next-line no-await-in-loop
      await act(() => new Promise((r) => setTimeout(r, 320)));
    }
    expect(screen.getByTestId("tutorial-dialog:finished")).toBeTruthy();
    expect(api.tour.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("tutorial-dialog:start"));
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(api.tour.start).toHaveBeenCalledWith(FALLBACK_SCENARIO_ID);
  });

  it("U7 — '실행하기' on a card fires tour.start for that card's scenario", async () => {
    const api = makeApi();
    const onOpenChange = vi.fn();
    render(<TutorialDialog open onOpenChange={onOpenChange} api={api} />);
    // Top card is DISCOVERY_CARDS[0] (meeting-summary).
    fireEvent.click(screen.getByTestId("tutorial-dialog:run"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(api.tour.start).toHaveBeenCalledWith(
      DISCOVERY_CARDS[0].spotlightScenarioId,
    );
    expect(api.tutorialRecord).toHaveBeenCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "liked",
    });
  });

  it("U7 — preview steps render for every card", () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    const steps = screen.getByTestId("tutorial-dialog:preview-steps");
    // The first card (meeting-summary) has 4 preview steps.
    expect(steps.querySelectorAll("li").length).toBe(
      DISCOVERY_CARDS[0].previewSteps.length,
    );
  });

  it("does not render when open is false", () => {
    const api = makeApi();
    render(<TutorialDialog open={false} onOpenChange={() => {}} api={api} />);
    expect(screen.queryByTestId("tutorial-dialog")).toBeNull();
  });

  // F5 — `prefers-reduced-motion: reduce` swaps the rotate(...) deck
  // transforms for opacity-only positioning so vestibular-sensitive
  // users do not see the cards tilt. The `data-reduce-motion="true"`
  // marker on the active deck root makes the swap inspectable from the
  // DOM without re-reading inline styles.
  it("uses instant card swap when prefers-reduced-motion is set (F5)", () => {
    const originalMatchMedia = window.matchMedia;
    // @ts-expect-error — jsdom polyfill from setup.ts is mutable.
    window.matchMedia = (query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      media: query,
    });
    try {
      const api = makeApi();
      render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
      const active = screen.getByTestId("tutorial-dialog:active");
      expect(active.getAttribute("data-reduce-motion")).toBe("true");
      // The decorative back/middle cards drop their `rotate(...)`
      // transform under reduced motion. We assert via the sibling
      // `aria-hidden` decorative divs inside the active deck.
      const decoratives = active.querySelectorAll('[aria-hidden="true"]');
      for (const node of Array.from(decoratives)) {
        const styleTransform = (node as HTMLElement).style.transform || "";
        expect(styleTransform).not.toContain("rotate");
      }
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
