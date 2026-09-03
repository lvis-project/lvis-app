// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { OverlayCard } from "../OverlayCard.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";

/**
 * The proposal variant of the overlay card.
 *
 * A proposal asks a question, so its card offers the three answers instead of
 * the single confirm every other overlay card carries — and it must offer them
 * INSTEAD, not alongside, or the user would have two ways to accept and only
 * one of them would be recorded.
 */
function renderProposal(overrides: Partial<Parameters<typeof OverlayCard>[0]> = {}) {
  const onAccept = vi.fn();
  const onLater = vi.fn();
  const onNever = vi.fn();
  const onDismiss = vi.fn();
  const view = render(
    <TooltipProvider>
      <OverlayCard
        title="Record this meeting?"
        summary="Recording, transcript and summary, in one step."
        firedAt={new Date().toISOString()}
        running={false}
        queueIndex={1}
        queueTotal={1}
        onPrev={() => {}}
        onNext={() => {}}
        onDismiss={onDismiss}
        expanded={false}
        onExpandedChange={() => {}}
        primaryActionLabel="Start recording"
        dispositions={{ onAccept, onLater, onNever }}
        kind="plugin"
        {...overrides}
      />
    </TooltipProvider>,
  );
  return { view, onAccept, onLater, onNever, onDismiss };
}

describe("OverlayCard — proposal dispositions", () => {
  it("offers exactly three answers, with the plugin's own accept label", () => {
    const { view } = renderProposal();
    expect(view.getByTestId("overlay-card-disposition-accept").textContent)
      .toBe("Start recording");
    expect(view.getByTestId("overlay-card-disposition-later")).toBeTruthy();
    expect(view.getByTestId("overlay-card-disposition-never")).toBeTruthy();
  });

  it("reports each answer once, and only the one that was clicked", () => {
    const { view, onAccept, onLater, onNever } = renderProposal();

    fireEvent.click(view.getByTestId("overlay-card-disposition-later"));
    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onNever).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId("overlay-card-disposition-never"));
    expect(onNever).toHaveBeenCalledTimes(1);

    fireEvent.click(view.getByTestId("overlay-card-disposition-accept"));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("replaces the single primary action rather than sitting beside it", () => {
    const onPrimaryAction = vi.fn();
    const { view } = renderProposal({ onPrimaryAction });
    expect(view.queryByTestId("overlay-card-primary-action")).toBeNull();
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it("leaves an ordinary card's single primary action alone", () => {
    const onPrimaryAction = vi.fn();
    const { view } = renderProposal({ dispositions: undefined, onPrimaryAction });
    expect(view.queryByTestId("overlay-card-dispositions")).toBeNull();
    fireEvent.click(view.getByTestId("overlay-card-primary-action"));
    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
  });
});
