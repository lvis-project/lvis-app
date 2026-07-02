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
