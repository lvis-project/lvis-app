import { SIDE_PANEL_MIN_WIDTH } from "../shared/side-panel.js";

export type WorkAreaBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MAIN_WINDOW_WIDTH = 460;
const MAIN_WINDOW_HEIGHT = 840;
export const MAIN_WINDOW_MIN_WIDTH = 460;
export const MAIN_WINDOW_MIN_HEIGHT = 640;
// Width the OS window reserves for the docked side panel in chat mode. This is
// the panel's MINIMUM width (the drag handle cannot go below it) so the window
// always has room for at least a collapsed panel; widening past it reflows the
// chat column rather than growing the window. SoT: src/shared/side-panel.ts.
export const CHAT_SIDE_PANEL_WIDTH = SIDE_PANEL_MIN_WIDTH;
const MAIN_WINDOW_TOP_GAP = 24;
const MAIN_WINDOW_BOTTOM_GAP = 24;
const MAIN_WINDOW_RIGHT_GAP = 10;

/**
 * Work-mode window size — a centered working canvas. SoT shared by the
 * initial-bounds path (createWindow, when the persisted mode is "work") and
 * the runtime resize-for-mode tween (window-manager). Centralized here so the
 * two code paths cannot drift to different dimensions.
 */
// Golden-ratio landscape: height 768, width = round(768 × φ) = 1243 (φ≈1.618).
export const WORK_MODE_WIDTH = 1243;
export const WORK_MODE_HEIGHT = 768;

function initialMainWindowY(
  workArea: WorkAreaBounds,
  height: number,
  platform: NodeJS.Platform
): number {
  const availableVerticalSpace = Math.max(0, workArea.height - height);
  if (platform === "win32") {
    return workArea.y + Math.max(0, availableVerticalSpace - MAIN_WINDOW_BOTTOM_GAP);
  }

  return workArea.y + Math.min(MAIN_WINDOW_TOP_GAP, availableVerticalSpace);
}

export function computeInitialMainWindowBounds(
  workArea: WorkAreaBounds,
  platform: NodeJS.Platform = process.platform
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(MAIN_WINDOW_MIN_WIDTH, Math.min(MAIN_WINDOW_WIDTH, workArea.width));
  const height = Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.min(MAIN_WINDOW_HEIGHT, workArea.height));
  const rightGap = width < workArea.width ? MAIN_WINDOW_RIGHT_GAP : 0;
  return {
    x: workArea.x + workArea.width - width - rightGap,
    y: initialMainWindowY(workArea, height, platform),
    width,
    height,
  };
}

/**
 * Work-mode bounds: centered {@link WORK_MODE_WIDTH}×{@link WORK_MODE_HEIGHT}
 * canvas, clamped to the work area. Used both for the initial window bounds when
 * the persisted mode is "work" and for the resize-for-mode tween target.
 */
export function computeWorkModeBounds(
  workArea: WorkAreaBounds
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(workArea.width, WORK_MODE_WIDTH);
  const height = Math.min(workArea.height, WORK_MODE_HEIGHT);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

/**
 * Chat mode with the right-side work panel open. Keep the chat window
 * right-docked like normal chat mode, but reserve enough width for the
 * 28rem side panel so the panel does not cover the transcript.
 */
export function computeChatModeSidePanelBounds(
  workArea: WorkAreaBounds,
  platform: NodeJS.Platform = process.platform
): { x: number; y: number; width: number; height: number } {
  const chatBounds = computeInitialMainWindowBounds(workArea, platform);
  const width = Math.min(workArea.width, chatBounds.width + CHAT_SIDE_PANEL_WIDTH);
  const rightGap = width < workArea.width ? MAIN_WINDOW_RIGHT_GAP : 0;
  return {
    ...chatBounds,
    x: workArea.x + workArea.width - width - rightGap,
    width,
  };
}
