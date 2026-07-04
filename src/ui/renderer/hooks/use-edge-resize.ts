import { useCallback, useEffect, useRef } from "react";

/**
 * Shared drag-to-resize primitive for edge-anchored panels (the left
 * navigation Sidebar's right edge, the right-docked ChatSidePanel's left
 * edge). One code path for pointer-capture drag + rAF-coalesced DOM-direct
 * width application (no per-frame React re-render) + keyboard steps +
 * double-click reset, so both panels share identical drag feel, hit
 * geometry, and persistence semantics. Visual/a11y chrome lives in the
 * sibling `EdgeResizeBar` component — this hook is presentation-free.
 *
 * `edge` determines the drag-delta sign: a "start" edge (bar on the panel's
 * leading side, panel grows AWAY from the bar — e.g. the right-docked side
 * panel's LEFT edge) inverts the pointer delta relative to an "end" edge
 * (bar on the panel's trailing side, panel grows WITH the pointer — e.g. the
 * left sidebar's RIGHT edge).
 */
export interface UseEdgeResizeOptions {
  /** Current width (px) — the source of truth the drag starts from. */
  width: number;
  /** Which side of the panel the bar sits on. See class doc above. */
  edge: "start" | "end";
  /** Per-move update (state only, no persist). Called every rAF tick during drag and on keyboard steps. */
  onWidthChange: (px: number) => void;
  /** Drag-end / keyboard-step / reset commit (persist). */
  onWidthCommit: (px: number) => void;
  /** Inclusive width bounds. May be a function so the max can depend on live viewport size (e.g. side panel's `100vw - margin`). */
  min: number;
  max: number | (() => number);
  /** Keyboard arrow-key step size (px). Default 16. */
  keyStep?: number;
  /** Optional element the drag applies the live width to directly (bypassing React) for a jank-free drag. Omit to update only via onWidthChange. */
  applyElementRef?: { current: HTMLElement | null };
}

export interface UseEdgeResizeResult {
  /** Wire directly to the resize bar's onPointerDown. */
  onPointerDown: (event: React.PointerEvent) => void;
  /** Wire directly to the resize bar's onKeyDown (Arrow keys + Home/End). */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Wire directly to the resize bar's onDoubleClick — resets to `resetWidth`. */
  makeResetHandler: (resetWidth: number) => (event: React.MouseEvent) => void;
  /** Current resolved max (evaluates the `max` option if it is a function). */
  resolveMax: () => number;
}

export function useEdgeResize({
  width,
  edge,
  onWidthChange,
  onWidthCommit,
  min,
  max,
  keyStep = 16,
  applyElementRef,
}: UseEdgeResizeOptions): UseEdgeResizeResult {
  const cleanupRef = useRef<(() => void) | null>(null);
  // Latest drag-live width, read by the drag-end closure (non-reactive) so the
  // committed value is exact even if React state lags a frame.
  const liveRef = useRef(width);
  useEffect(() => {
    liveRef.current = width;
  }, [width]);
  // Release any in-flight pointer capture on unmount so a drag crossing an
  // unmount boundary (panel closes / tab switch mid-drag) leaks no listeners.
  useEffect(() => () => cleanupRef.current?.(), []);

  const resolveMax = useCallback(() => (typeof max === "function" ? max() : max), [max]);
  const clamp = useCallback(
    (value: number) => Math.round(Math.min(resolveMax(), Math.max(min, value))),
    [min, resolveMax],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
      cleanupRef.current?.();
      const startX = event.clientX;
      const startWidth = width;
      const sign = edge === "end" ? 1 : -1;
      let raf = 0;
      const apply = (clientX: number) => {
        const next = clamp(startWidth + sign * (clientX - startX));
        liveRef.current = next;
        onWidthChange(next);
        const el = applyElementRef?.current;
        if (!el) return;
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          el.style.width = `${liveRef.current}px`;
        });
      };
      const onMove = (moveEvent: PointerEvent) => apply(moveEvent.clientX);
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        if (raf) cancelAnimationFrame(raf);
        cleanupRef.current = null;
        onWidthCommit(liveRef.current);
      };
      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [applyElementRef, clamp, edge, onWidthChange, onWidthCommit, width],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Arrow-key direction always matches the visual edge regardless of
      // sign convention: ArrowLeft/ArrowRight shrink/grow as if dragging the
      // bar itself, so ArrowRight always widens a right-side ("end") bar and
      // narrows a left-side ("start") bar, and vice versa.
      const growKey = edge === "end" ? "ArrowRight" : "ArrowLeft";
      const shrinkKey = edge === "end" ? "ArrowLeft" : "ArrowRight";
      if (event.key === growKey) {
        event.preventDefault();
        onWidthCommit(clamp(width + keyStep));
      } else if (event.key === shrinkKey) {
        event.preventDefault();
        onWidthCommit(clamp(width - keyStep));
      } else if (event.key === "Home") {
        event.preventDefault();
        onWidthCommit(min);
      } else if (event.key === "End") {
        event.preventDefault();
        onWidthCommit(resolveMax());
      }
    },
    [clamp, edge, keyStep, min, onWidthCommit, resolveMax, width],
  );

  const makeResetHandler = useCallback(
    (resetWidth: number) => (event: React.MouseEvent) => {
      event.preventDefault();
      onWidthCommit(clamp(resetWidth));
    },
    [clamp, onWidthCommit],
  );

  return { onPointerDown, onKeyDown, makeResetHandler, resolveMax };
}
