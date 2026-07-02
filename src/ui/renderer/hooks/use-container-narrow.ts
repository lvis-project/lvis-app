import { useEffect, useState, type RefObject } from "react";

export interface UseContainerNarrowResult {
  /** True when the observed container is too narrow to dock the side panel. */
  isNarrow: boolean;
  /** Latest observed content-box inline size (px); Infinity until first measure. */
  width: number;
}

/**
 * Observe an element's inline size and report whether it is "narrow" with
 * hysteresis (enter < 900, exit >= 960 by default; 60px dead-band) so window /
 * sidebar resizing near the boundary does not flip-flop.
 *
 * The element to observe is the PARENT of the docked/drawer branch so that
 * switching branches (which removes the ~448px docked sibling from flow) does
 * NOT change the measured width — no self-oscillation. In jsdom (no
 * ResizeObserver) it reports the docked default (isNarrow=false), preserving
 * the existing layout for unit tests.
 */
export function useContainerNarrow(
  ref: RefObject<HTMLElement | null>,
  { enter = 900, exit = 960 }: { enter?: number; exit?: number } = {},
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
