import { useEffect, useRef, type ReactNode } from "react";
import {
  SIDE_PANEL_SPLIT_MAX_PERCENT,
  SIDE_PANEL_SPLIT_MIN_PERCENT,
  clampSidePanelSplitPercent,
} from "../../../shared/side-panel.js";

/** Keyboard nudge step (percent) for the split separator. */
const SPLIT_KEY_STEP = 5;

/**
 * A vertical (top↕bottom) split layout with a draggable + keyboard-operable
 * separator, extracted from the file-browser's inline splitter so the
 * file-browser, preview, and subagent tabs share one implementation. The top
 * pane's height share is `topPercent`; the bottom pane takes the remainder.
 *
 * Ownership split: this component draws the panes + separator and reports drag /
 * keyboard changes UP via `onDragChange` (per-move, no persist) and
 * `onCommit` (drag-end / keyboard step, persist). The PERCENT itself is owned by
 * the caller (a `useVerticalSplit` store) so it survives the panel unmount.
 *
 * Its pointer-capture cleanup lives in a LOCAL ref (`resizeCleanupRef`), never
 * shared with the panel's horizontal-width drag — the two can be in flight
 * against different DOM handles, so a shared ref would tear one down mid-drag.
 * The `rect.height <= 0` early-return guards the drawer-collapsed case (a folded
 * sheet reports zero height, which would otherwise divide to NaN).
 */
export function VerticalSplitLayout({
  topPercent,
  onDragChange,
  onCommit,
  top,
  bottom,
  ariaLabel,
  testId,
  separatorTestId,
}: {
  topPercent: number;
  /** Per-move update (state only, no persist). */
  onDragChange: (percent: number) => void;
  /** Drag-end / keyboard commit (persist). */
  onCommit: (percent: number) => void;
  top: ReactNode;
  bottom: ReactNode;
  ariaLabel: string;
  testId?: string;
  separatorTestId?: string;
}) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Latest drag value, read by the drag-end closure (non-reactive) so the
  // committed value is exact even if React state lags a frame.
  const liveRef = useRef(topPercent);
  useEffect(() => {
    liveRef.current = topPercent;
  }, [topPercent]);

  // Release any in-flight pointer capture on unmount so a drag crossing an
  // unmount boundary (tab switch / panel close mid-drag) leaks no listeners.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const percentFromClientY = (clientY: number): number | null => {
    const layout = layoutRef.current;
    if (!layout) return null;
    const rect = layout.getBoundingClientRect();
    // Drawer-collapsed / zero-height guard: dividing by 0 → NaN → broken grid.
    if (rect.height <= 0) return null;
    return clampSidePanelSplitPercent(((clientY - rect.top) / rect.height) * 100);
  };

  const applyFromClientY = (clientY: number) => {
    const next = percentFromClientY(clientY);
    if (next == null) return;
    liveRef.current = next;
    onDragChange(next);
  };

  return (
    // The separator ROW is 1.25rem (20px) tall so the whole row is the pointer
    // hit zone — above the ~20-24px floor for a reliable drag. The VISUAL line
    // inside stays thin (2px, `h-0.5`), centered by `items-center`, so the
    // widened interactive area costs no extra visible chrome.
    <div
      ref={layoutRef}
      className="grid min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      data-testid={testId}
      style={{ gridTemplateRows: `${topPercent}% 1.25rem minmax(0, 1fr)` }}
    >
      <div className="min-h-0 overflow-auto">{top}</div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={ariaLabel}
        aria-valuenow={Math.round(topPercent)}
        aria-valuemin={SIDE_PANEL_SPLIT_MIN_PERCENT}
        aria-valuemax={SIDE_PANEL_SPLIT_MAX_PERCENT}
        tabIndex={0}
        data-testid={separatorTestId}
        className="group flex cursor-row-resize touch-none select-none items-center px-2 outline-none"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          resizeCleanupRef.current?.();
          applyFromClientY(event.clientY);
          const onMove = (moveEvent: PointerEvent) => applyFromClientY(moveEvent.clientY);
          const cleanup = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", cleanup);
            window.removeEventListener("pointercancel", cleanup);
            resizeCleanupRef.current = null;
            onCommit(liveRef.current);
          };
          resizeCleanupRef.current = cleanup;
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", cleanup);
          window.addEventListener("pointercancel", cleanup);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            const next = clampSidePanelSplitPercent(topPercent - SPLIT_KEY_STEP);
            onDragChange(next);
            onCommit(next);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            const next = clampSidePanelSplitPercent(topPercent + SPLIT_KEY_STEP);
            onDragChange(next);
            onCommit(next);
          } else if (event.key === "Home") {
            event.preventDefault();
            onDragChange(SIDE_PANEL_SPLIT_MIN_PERCENT);
            onCommit(SIDE_PANEL_SPLIT_MIN_PERCENT);
          } else if (event.key === "End") {
            event.preventDefault();
            onDragChange(SIDE_PANEL_SPLIT_MAX_PERCENT);
            onCommit(SIDE_PANEL_SPLIT_MAX_PERCENT);
          }
        }}
      >
        <span className="h-0.5 w-full rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <div className="min-h-0 overflow-auto">{bottom}</div>
    </div>
  );
}
