/**
 * Dropping a conversation onto a tile.
 *
 * The gesture says two things at once — WHICH conversation, and WHERE it goes —
 * and the second one is the edge it lands on. An outer band on any of a tile's
 * four sides splits that tile on the matching axis; the middle replaces what the
 * tile is holding. That is the same gesture editor groups use elsewhere, so it
 * needs no teaching, and it is the only model where the shape the user wants is
 * expressed by where they let go rather than by a separate control.
 */
import type { DropEdge } from "./pane-tree.js";

/** The drag payload's MIME type. Own type so a file drag never looks like one. */
export const CHAT_SESSION_DRAG_TYPE = "application/x-lvis-chat-session";

/** How far in from an edge still counts as that edge, in px. */
const EDGE_BAND_PX = 40;
/** …but never more than this share of the tile, so a small tile keeps a middle. */
const EDGE_BAND_MAX_SHARE = 0.3;

export type DropTarget = DropEdge | "center";

/**
 * Which part of a tile a pointer is over.
 *
 * The band scales down on a small tile: a fixed 40px on a 200px-wide tile would
 * leave a 120px middle, and on anything narrower the middle would vanish
 * entirely — turning "replace" into a target the user cannot hit.
 */
export function dropTargetAt(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
): DropTarget {
  const bandX = Math.min(EDGE_BAND_PX, rect.width * EDGE_BAND_MAX_SHARE);
  const bandY = Math.min(EDGE_BAND_PX, rect.height * EDGE_BAND_MAX_SHARE);
  const fromLeft = point.x - rect.left;
  const fromTop = point.y - rect.top;
  const fromRight = rect.left + rect.width - point.x;
  const fromBottom = rect.top + rect.height - point.y;

  const candidates: Array<{ edge: DropTarget; depth: number }> = [
    { edge: "left", depth: fromLeft <= bandX ? fromLeft : Infinity },
    { edge: "right", depth: fromRight <= bandX ? fromRight : Infinity },
    { edge: "top", depth: fromTop <= bandY ? fromTop : Infinity },
    { edge: "bottom", depth: fromBottom <= bandY ? fromBottom : Infinity },
  ];
  // The nearest edge wins, so a corner resolves to one side rather than
  // flickering between two as the pointer moves a pixel.
  const nearest = candidates.reduce((best, each) => (each.depth < best.depth ? each : best));
  return nearest.depth === Infinity ? "center" : nearest.edge;
}

/** Where the drop indicator should be drawn, as CSS percentages. */
export function dropIndicatorStyle(target: DropTarget): {
  left: string; top: string; width: string; height: string;
} {
  switch (target) {
    case "left": return { left: "0%", top: "0%", width: "50%", height: "100%" };
    case "right": return { left: "50%", top: "0%", width: "50%", height: "100%" };
    case "top": return { left: "0%", top: "0%", width: "100%", height: "50%" };
    case "bottom": return { left: "0%", top: "50%", width: "100%", height: "50%" };
    case "center": return { left: "0%", top: "0%", width: "100%", height: "100%" };
  }
}
