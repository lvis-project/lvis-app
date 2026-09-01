// FloatingRightLane — the one anchor for everything that hangs off the
// top-right corner of the chat column.
//
// The action panel (open or collapsed to its rail) and the overlay card each
// used to carry its own `absolute right-4 top-2`, at z-50 and z-20. Same point,
// different layers, so the rail's 44px button column was painted straight over
// the overlay card's close and queue-navigation controls — and because that
// button is `pointer-events-auto`, a click aimed at the card's "닫기" opened the
// action panel instead. Raising the card's z-index would only swap which one is
// unreachable; the two genuinely want to coexist, so they share a lane and
// stack in it.
//
// Consequences worth knowing: DOM order here is stacking order (action panel
// above, overlay card below it), and an open action panel pushes the card down
// rather than covering it.
import type { ReactNode } from "react";

/**
 * Width shared by every occupant of the lane, so two surfaces sitting one above
 * the other line up instead of stepping in and out by a few pixels. The
 * `max-w` clamp is what keeps the lane on-screen in a narrow window.
 */
export const FLOATING_LANE_ITEM_WIDTH = "w-[23rem] max-w-[calc(100%-2rem)]";

export function FloatingRightLane({ children }: { children: ReactNode }) {
  return (
    <div
      // `pointer-events-none` on the lane and `-auto` on each occupant: the lane
      // spans dead space between and beside its children, and chat has to stay
      // clickable through it.
      className="pointer-events-none absolute right-4 top-2 z-50 flex flex-col items-end gap-2"
      data-testid="floating-right-lane"
    >
      {children}
    </div>
  );
}
