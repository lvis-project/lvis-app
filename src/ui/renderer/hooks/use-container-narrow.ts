import { useEffect, useState, type RefObject } from "react";
import { SIDE_PANEL_MIN_WIDTH } from "../../../shared/side-panel.js";

export interface UseContainerNarrowResult {
  /** True when the observed container is too narrow to dock the side panel. */
  isNarrow: boolean;
  /** Latest observed content-box inline size (px); Infinity until first measure. */
  width: number;
}

/**
 * Minimum transcript column width that must survive alongside the docked side
 * panel for docking to be usable. Below this the panel would crush the chat
 * transcript, so the drawer fallback is warranted; at or above it both panes
 * stay interactive side by side.
 */
const MIN_DOCKED_TRANSCRIPT_WIDTH = 320;

/**
 * Container width at/below which docking both the transcript and the side panel
 * is physically too tight — derived from the shared side-panel min width plus a
 * transcript floor rather than a magic constant, so it tracks the panel SoT.
 * Chat mode's OS window reserves exactly `SIDE_PANEL_MIN_WIDTH` on top of its
 * base width to host the docked panel, so its container clears this threshold
 * and docks (not the modal drawer). The drawer only triggers for genuinely
 * too-narrow containers (e.g. a hand-shrunk work-mode window).
 */
export const DOCK_ENTER_WIDTH = SIDE_PANEL_MIN_WIDTH + MIN_DOCKED_TRANSCRIPT_WIDTH;
/** Exit width — 60px dead-band above enter to avoid flip-flop near the boundary. */
export const DOCK_EXIT_WIDTH = DOCK_ENTER_WIDTH + 60;

/**
 * Below the docking threshold the two columns cannot both keep their pixel
 * floors, so they share the container instead: the split bar moves between
 * these shares of its width, and the user still decides which column gets
 * the room.
 */
const NARROW_PANEL_MIN_SHARE = 0.3;
const NARROW_PANEL_MAX_SHARE = 0.7;

/**
 * The width range a docked side panel may take inside a container `width`
 * px across. The panel is always a column of its container — never a sheet
 * over it — so the range is what changes with the container, not the
 * presentation. An unmeasured container (Infinity) keeps the pixel floors.
 */
export function dockedPanelRange(width: number): { min: number; max: number } {
  if (!Number.isFinite(width)) return { min: SIDE_PANEL_MIN_WIDTH, max: Number.POSITIVE_INFINITY };
  if (width >= DOCK_ENTER_WIDTH) {
    return { min: SIDE_PANEL_MIN_WIDTH, max: width - MIN_DOCKED_TRANSCRIPT_WIDTH };
  }
  return {
    min: Math.round(width * NARROW_PANEL_MIN_SHARE),
    max: Math.round(width * NARROW_PANEL_MAX_SHARE),
  };
}

/**
 * Observe an element's inline size and report it, plus whether it is "narrow"
 * — too narrow to hold both the side panel's and the transcript's pixel
 * floors — with hysteresis (enter < {@link DOCK_ENTER_WIDTH}, exit >=
 * {@link DOCK_EXIT_WIDTH}; 60px dead-band) so resizing near the boundary does
 * not flip-flop. ChatView reads `width` and sizes its docked panel through
 * {@link dockedPanelRange}; Settings reads `isNarrow` for its own layout.
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
