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
 * The action panel has since left this corner entirely: it hangs off the chat
 * group's header now, so the collision it caused cannot recur from that side.
 * The lane remains the single anchor for whatever DOES hang here, and these
 * assertions keep the rule that made the collision impossible — the lane
 * positions, the occupant does not.
 *
 * jsdom has no layout, so overlap itself is not measurable here. What IS
 * measurable is the cause: whether an occupant positions itself.
 */
import "../../../../../test/renderer/setup.js";
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
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

/** Render the lane the way ChatView does in work mode. */
function renderLane() {
  const addFireRef = createRef<((item: OverlayItem) => void) | null>();
  const view = render(
    <TooltipProvider>
      <OverlayContextProvider onOpenSession={() => true} addFireRef={addFireRef}>
        <FloatingRightLane>
          <OverlayCardRegion
            chatGroupId="main"
            actionChatGroupId="main"
            overlayCardTile={() => ({ chatGroupId: "main", orphaned: false })}
            onPluginPrimaryAction={vi.fn()}
          />
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
  it("stacks its occupants instead of piling them at one point", () => {
    renderLane();

    const lane = screen.getByTestId("floating-right-lane");
    const card = screen.getByTestId("overlay-card-region");

    // In the lane — a sibling that escaped it would be back to positioning
    // itself.
    expect(lane.contains(card)).toBe(true);
    expect(lane.className).toContain("flex-col");
  });

  it("leaves positioning to the lane — the occupant does not anchor itself", () => {
    renderLane();

    const className = screen.getByTestId("overlay-card-region").className;
    expect(className, "overlay-card-region must not position itself").not.toMatch(/\babsolute\b/);
    expect(className, "overlay-card-region must not set its own layer").not.toMatch(/\bz-\d/);
  });

  it("no longer carries the action panel — it hangs off the group header now", () => {
    renderLane();

    const lane = screen.getByTestId("floating-right-lane");
    expect(lane.querySelector("[data-testid='action-panel-open']")).toBeNull();
    expect(lane.querySelector("[data-testid='action-panel']")).toBeNull();
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
