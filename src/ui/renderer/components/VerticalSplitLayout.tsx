import { useRef, type ReactNode } from "react";
import {
  SIDE_PANEL_SPLIT_MAX_PERCENT,
  SIDE_PANEL_SPLIT_MIN_PERCENT,
} from "../../../shared/side-panel.js";
import { useEdgeResize, useMeasuredSize } from "../hooks/use-edge-resize.js";

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
 * The drag is `useEdgeResize`, the same primitive the sidebar, the side panel
 * and the pane gutters resize with: the top pane is the "panel", its
 * percent is the "width", and `unitsPerPixel` turns the pointer's px into
 * percent of this layout. Until the layout has a measured height there is no
 * conversion, so the pointer is not wired — a drawer folded to zero height
 * would otherwise divide to NaN — while the keyboard, which steps in percent
 * and needs no height, always is.
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
  const { height } = useMeasuredSize(layoutRef);
  const measured = height > 0;

  const { onPointerDown, onKeyDown } = useEdgeResize({
    width: topPercent,
    edge: "end",
    axis: "y",
    ...(measured ? { unitsPerPixel: 100 / height } : {}),
    min: SIDE_PANEL_SPLIT_MIN_PERCENT,
    max: SIDE_PANEL_SPLIT_MAX_PERCENT,
    keyStep: SPLIT_KEY_STEP,
    onWidthChange: onDragChange,
    // A keyboard step is both the move and the commit; the hook reports it
    // once, as a commit, so the move is replayed here for the caller.
    onWidthCommit: (percent) => {
      onDragChange(percent);
      onCommit(percent);
    },
  });

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
        onPointerDown={measured ? onPointerDown : undefined}
        onKeyDown={onKeyDown}
      >
        <span className="h-0.5 w-full rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <div className="min-h-0 overflow-auto">{bottom}</div>
    </div>
  );
}
