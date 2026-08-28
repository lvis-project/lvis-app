import { useEffect, useState, type RefObject } from "react";
import { SIDE_PANEL_MIN_RESERVE } from "../../../shared/side-panel.js";

export interface UseContainerNarrowResult {
  /** True when the observed container is too narrow to dock the side panel. */
  isNarrow: boolean;
  /** Latest observed content-box inline size (px); Infinity until first measure. */
  width: number;
}

/**
 * Minimum transcript column width that must survive beside the docked side
 * panel (card plus its insets) for docking to be usable. Below this the panel would crush the chat
 * transcript, so the panel floats over it instead; at or above it both panes
 * stay interactive side by side.
 */
const MIN_DOCKED_TRANSCRIPT_WIDTH = 320;

/**
 * Container width at/below which docking both the transcript and the side panel
 * is physically too tight — derived from the shared side-panel reserve plus a
 * transcript floor rather than a magic constant, so it tracks the panel SoT.
 * Chat mode's OS window reserves exactly `SIDE_PANEL_MIN_RESERVE` on top of its
 * base width to host the docked panel, so its container clears this threshold
 * and docks. Floating only happens in genuinely too-narrow containers (a
 * split tile, a hand-shrunk work-mode window).
 */
export const DOCK_ENTER_WIDTH = SIDE_PANEL_MIN_RESERVE + MIN_DOCKED_TRANSCRIPT_WIDTH;
/** Exit width — 60px dead-band above enter to avoid flip-flop near the boundary. */
export const DOCK_EXIT_WIDTH = DOCK_ENTER_WIDTH + 60;

type SidePanelLayoutMode = "docked" | "overlay";


export interface SidePanelLayout {
  /**
   * The panel is the same raised card in both — the floating sidebar's shape.
   * `docked`: the card is a column beside the transcript and pushes it.
   * `overlay`: the container cannot hold both pixel floors, so the card keeps
   * its own floor and floats over the transcript's right edge inside the
   * container — the transcript keeps its layout underneath instead of being
   * crushed into a strip nobody could use. Never a window-level sheet.
   */
  mode: SidePanelLayoutMode;
  /** The range the split bar moves in. */
  min: number;
  max: number;
}

/**
 * How the side panel lays out inside a container `width` px across, and the
 * range its reserve (card plus insets) may take there. `narrow` is
 * {@link useContainerNarrow}'s hysteresis verdict, not a fresh comparison: the
 * two modes give the panel different ranges, so a mode that flipped on a
 * single threshold would jump the panel's width back and forth while a tile
 * gutter is dragged across it. An unmeasured container (Infinity) docks with
 * the pixel floors.
 */
export function sidePanelLayout(width: number, narrow: boolean): SidePanelLayout {
  if (!Number.isFinite(width)) return { mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: Number.POSITIVE_INFINITY };
  if (!narrow) {
    return { mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: Math.max(SIDE_PANEL_MIN_RESERVE, width - MIN_DOCKED_TRANSCRIPT_WIDTH) };
  }
  return { mode: "overlay", min: Math.min(SIDE_PANEL_MIN_RESERVE, width), max: width };
}

/**
 * Observe an element's inline size and report it, plus whether it is "narrow"
 * — too narrow to hold both the side panel's and the transcript's pixel
 * floors — with hysteresis (enter < {@link DOCK_ENTER_WIDTH}, exit >=
 * {@link DOCK_EXIT_WIDTH}; 60px dead-band) so resizing near the boundary does
 * not flip-flop. ChatView lays its panel out through {@link sidePanelLayout}
 * from both; Settings reads `isNarrow` for its own layout.
 *
 * Observe the PARENT of whatever the answer lays out, so the answer never
 * changes what is measured. In jsdom (no ResizeObserver) the width stays
 * Infinity and `isNarrow` false — the pixel-floor layout unit tests expect.
 */
export function useContainerNarrow(
  ref: RefObject<HTMLElement | null>,
  { enter = DOCK_ENTER_WIDTH, exit = DOCK_EXIT_WIDTH }: { enter?: number; exit?: number } = {},
): UseContainerNarrowResult {
  const [state, setState] = useState<UseContainerNarrowResult>({ isNarrow: false, width: Infinity });

  useEffect(() => {
    const el = ref.current;
    const ResizeObserverImpl = typeof window !== "undefined" ? window.ResizeObserver : undefined;
    if (!el || typeof ResizeObserverImpl !== "function") return;
    const observer = new ResizeObserverImpl((entries) => {
      const entry = entries[0];
      const width = entry?.contentBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width ?? Infinity;
      setState((prev) => ({
        width,
        isNarrow: prev.isNarrow ? width < exit : width < enter,
      }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enter, exit]);

  return state;
}
