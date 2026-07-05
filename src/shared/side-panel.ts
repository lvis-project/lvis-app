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
 * Primary (left) navigation sidebar width geometry. The sidebar is a floating
 * card whose expanded width is user-adjustable via a drag handle on its inner
 * edge; the value is persisted under `SystemSettings.sidebarWidth` (same durable
 * shell-preference family as `sidePanelWidth`). The default 232px matches the
 * historical `<main>` left-padding reserve (pl-[14.5rem]); the card itself is
 * inset ~8px from the window edge, so the padding tracks `sidebarWidth`
 * directly. Collapsed rail width is fixed and not covered by these bounds.
 */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 232;

/**
 * Clamp a raw sidebar width (px) to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] and
 * round. Non-finite input falls back to the default so a bad measurement can
 * never poison the persisted width.
 */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value)));
}

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

/**
 * Clamp a raw split percent to the allowed pane range, then round. Non-finite
 * input (NaN from a zero-height rect, ±Infinity) falls back to the default so a
 * bad measurement can never poison the persisted ratio. Clamp precedes round so
 * the result is a rounded value guaranteed to sit inside [MIN, MAX].
 */
export function clampSidePanelSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return SIDE_PANEL_SPLIT_DEFAULT_PERCENT;
  const clamped = Math.min(
    SIDE_PANEL_SPLIT_MAX_PERCENT,
    Math.max(SIDE_PANEL_SPLIT_MIN_PERCENT, value),
  );
  return Math.round(clamped);
}
