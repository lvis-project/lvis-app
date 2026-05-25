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
