/**
 * Single source of truth for the ChatSidePanel (right-docked workspace rail)
 * width geometry, shared by the renderer (drag-resize + persisted width) and
 * the main process window-bounds math.
 *
 * The invariant "panel minimum width == the width the OS window reserves for
 * the docked panel in chat mode" lives here so the two sides cannot drift:
 * `main-window-bounds.ts` derives `CHAT_SIDE_PANEL_WIDTH` from
 * `SIDE_PANEL_MIN_WIDTH`, and the renderer clamps the drag handle to the same
 * floor. 448px == 28rem.
 */
export const SIDE_PANEL_MIN_WIDTH = 448;
export const SIDE_PANEL_DEFAULT_WIDTH = 448;

/**
 * Vertical (top/bottom) split geometry for the workspace-rail tabs whose body is
 * a list-over-viewer layout (file-browser, preview, subagent). The percent is
 * the TOP pane's share of the tab body height; the bottom pane takes the rest.
 * Clamped to [MIN, MAX] at drag time so neither pane can collapse to zero.
 * Persisted per-tab-kind under `SystemSettings` so each surface keeps its own
 * ratio across restarts (same durable-preference family as `sidePanelWidth`).
 */
export const SIDE_PANEL_SPLIT_MIN_PERCENT = 22;
export const SIDE_PANEL_SPLIT_MAX_PERCENT = 78;
export const SIDE_PANEL_SPLIT_DEFAULT_PERCENT = 45;

/** Clamp + round a raw split percent to the allowed pane range. */
export function clampSidePanelSplitPercent(value: number): number {
  return Math.min(
    SIDE_PANEL_SPLIT_MAX_PERCENT,
    Math.max(SIDE_PANEL_SPLIT_MIN_PERCENT, Math.round(value)),
  );
}
