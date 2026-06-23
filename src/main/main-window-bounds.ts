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
const MAIN_WINDOW_TOP_GAP = 24;
const MAIN_WINDOW_BOTTOM_GAP = 24;
const MAIN_WINDOW_RIGHT_GAP = 10;

/**
 * Action-mode window size — a centered working canvas. SoT shared by the
 * initial-bounds path (createWindow, when the persisted mode is "action") and
 * the runtime resize-for-mode tween (window-manager). Centralized here so the
 * two code paths cannot drift to different dimensions.
 */
// Golden-ratio landscape: height 768, width = round(768 × φ) = 1243 (φ≈1.618).
export const ACTION_MODE_WIDTH = 1243;
export const ACTION_MODE_HEIGHT = 768;

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
 * Action-mode bounds: centered {@link ACTION_MODE_WIDTH}×{@link ACTION_MODE_HEIGHT}
 * canvas, clamped to the work area. Used both for the initial window bounds when
 * the persisted mode is "action" and for the resize-for-mode tween target.
 */
export function computeActionModeBounds(
  workArea: WorkAreaBounds
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(workArea.width, ACTION_MODE_WIDTH);
  const height = Math.min(workArea.height, ACTION_MODE_HEIGHT);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}
