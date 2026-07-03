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
 * Observe an element's inline size and report whether it is "narrow" — too
 * narrow to dock the side panel beside the transcript — with hysteresis
 * (enter < {@link DOCK_ENTER_WIDTH}, exit >= {@link DOCK_EXIT_WIDTH}; 60px
 * dead-band) so window / sidebar resizing near the boundary does not flip-flop.
 *
 * The element to observe is the PARENT of the docked/drawer branch so that
 * switching branches (which removes the ~448px docked sibling from flow) does
 * NOT change the measured width — no self-oscillation. In jsdom (no
 * ResizeObserver) it reports the docked default (isNarrow=false), preserving
 * the existing layout for unit tests.
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
