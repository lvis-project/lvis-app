// @vitest-environment jsdom
/**
 * FloatingRightLane — the invariant that stops the top-right overlays from
 * landing on each other.
 *
 * The bug this replaced: the action-panel rail and the overlay card each
 * carried its own `absolute right-4 top-2`, at z-50 and z-20. Same anchor,
 * different layers, so the rail's button column covered the overlay card's
 * close and queue controls — and since that button is `pointer-events-auto`, a
 * click aimed at the card's dismiss hit the rail instead.
 *
 * jsdom has no layout, so overlap itself is not measurable here. What IS
 * measurable is the cause: whether either occupant positions itself. A future
 * edit that puts `absolute` back on one of them re-creates the collision, and
 * that is what these assertions catch.
 */
import "../../../../../test/renderer/setup.js";
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ActionPanel } from "../ActionPanel.js";
import { emptyActionPanelActivity } from "../../../../../test/renderer/helpers.js";
import { FloatingRightLane } from "../FloatingRightLane.js";
import { OverlayCardRegion } from "../OverlayCardRegion.js";
import {
  OverlayContextProvider,
  type OverlayItem,
} from "../../context/OverlayContext.js";

const PLUGIN_ITEM: OverlayItem = {
  id: "plugin-lane-test",
  source: { kind: "plugin", pluginId: "demo", eventId: "e1" },
  title: "demo-alert",
  summary: "a staged alert",
  running: false,
  pendingPrompt: "do the thing",
  createdAt: "2026-08-23T00:00:00.000Z",
};

/** Render both lane occupants the way ChatView does in work mode. */
function renderLane() {
  const addFireRef = createRef<((item: OverlayItem) => void) | null>();
  const view = render(
    <TooltipProvider>
      <OverlayContextProvider onOpenSession={() => true} addFireRef={addFireRef}>
        <FloatingRightLane>
          <ActionPanel
            open={false}
            onOpenChange={vi.fn()}
            activity={emptyActionPanelActivity()}
            onOpenItem={vi.fn()}
            onOpenItemPinned={vi.fn()}
          />
          <OverlayCardRegion onPluginPrimaryAction={vi.fn()} />
        </FloatingRightLane>
      </OverlayContextProvider>
    </TooltipProvider>,
  );
  act(() => {
    addFireRef.current?.(PLUGIN_ITEM);
  });
  return view;
}

describe("FloatingRightLane", () => {
  it("stacks the action-panel rail and the overlay card instead of layering them", () => {
    renderLane();

    const lane = screen.getByTestId("floating-right-lane");
    const rail = screen.getByTestId("action-panel-rail");
    const card = screen.getByTestId("overlay-card-region");

    // Both are IN the lane — a sibling that escaped it would be back to
    // positioning itself.
    expect(lane.contains(rail)).toBe(true);
    expect(lane.contains(card)).toBe(true);
    // ...and stacked by it, not piled at one point.
    expect(lane.className).toContain("flex-col");
  });

  it("leaves positioning to the lane — neither occupant anchors itself", () => {
    renderLane();

    for (const testId of ["action-panel-rail", "overlay-card-region"]) {
      const className = screen.getByTestId(testId).className;
      expect(className, `${testId} must not position itself`).not.toMatch(/\babsolute\b/);
      expect(className, `${testId} must not set its own layer`).not.toMatch(/\bz-\d/);
    }
  });

  it("keeps the overlay card's own dismiss control reachable", () => {
    renderLane();

    // The control the rail used to sit on top of. Present, and inside the card
    // rather than behind another `pointer-events-auto` surface.
    const card = screen.getByTestId("overlay-card-region");
    const dismiss = screen.getByTestId("routine-card-dismiss");
    expect(card.contains(dismiss)).toBe(true);
  });
});
