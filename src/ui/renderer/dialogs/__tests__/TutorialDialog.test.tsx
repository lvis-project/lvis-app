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
    await flushAll();
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
    await flushAll();
    expect(api.tutorialRecord).toHaveBeenCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "disliked",
    });
  });

  it("keyboard ↑ likes and ↓ dislikes", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    await flushAll();
    expect(api.tutorialRecord).toHaveBeenCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "liked",
    });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await flushAll();
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
    await flushAll();
    fireEvent.click(screen.getByTestId("tutorial-dialog:undo"));
    await flushAll();
    expect(api.tutorialRecord).toHaveBeenLastCalledWith({
      cardId: DISCOVERY_CARDS[0].id,
      action: "undone",
    });
    const top = screen.getByTestId("tutorial-dialog:top-card");
    expect(top.getAttribute("data-card-id")).toBe(DISCOVERY_CARDS[0].id);
  });

  it("calls tour.start with the first liked scenario when the deck empties", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    // Card 1 disliked, Card 2 (doc-search) liked, rest skipped.
    fireEvent.click(screen.getByTestId("tutorial-dialog:dislike"));
    await flushAll();
    fireEvent.click(screen.getByTestId("tutorial-dialog:like"));
    await flushAll();
    for (let i = 2; i < DISCOVERY_CARDS.length; i += 1) {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
      // eslint-disable-next-line no-await-in-loop
      await flushAll();
    }
    expect(screen.getByTestId("tutorial-dialog:finished")).toBeTruthy();
    expect(api.tour.start).toHaveBeenCalledWith(
      DISCOVERY_CARDS[1].spotlightScenarioId,
    );
  });

  it("falls back to first-boot-essentials when the user did not like any card", async () => {
    const api = makeApi();
    render(<TutorialDialog open onOpenChange={() => {}} api={api} />);
    for (let i = 0; i < DISCOVERY_CARDS.length; i += 1) {
      fireEvent.click(screen.getByTestId("tutorial-dialog:dislike"));
      // eslint-disable-next-line no-await-in-loop
      await flushAll();
    }
    expect(api.tour.start).toHaveBeenCalledWith(FALLBACK_SCENARIO_ID);
  });

  it("does not render when open is false", () => {
    const api = makeApi();
    render(<TutorialDialog open={false} onOpenChange={() => {}} api={api} />);
    expect(screen.queryByTestId("tutorial-dialog")).toBeNull();
  });
});
