import { describe, expect, it } from "vitest";
import { CHAT_SIDE_PANEL_WIDTH, computeChatModeSidePanelBounds, computeInitialMainWindowBounds } from "../main-window-bounds.js";

describe("computeInitialMainWindowBounds", () => {
  it("keeps the default macOS placement at the upper-right of the work area", () => {
    const bounds = computeInitialMainWindowBounds(
      { x: 0, y: 0, width: 1920, height: 1080 },
      "darwin"
    );

    expect(bounds).toEqual({ x: 1450, y: 24, width: 460, height: 840 });
  });

  it("places the default Windows window at the lower-right of the work area", () => {
    const bounds = computeInitialMainWindowBounds(
      { x: 0, y: 0, width: 1920, height: 1080 },
      "win32"
    );

    expect(bounds).toEqual({ x: 1450, y: 216, width: 460, height: 840 });
  });

  it("honors offset work areas when computing Windows lower-right placement", () => {
    const bounds = computeInitialMainWindowBounds(
      { x: 100, y: 50, width: 1600, height: 900 },
      "win32"
    );

    expect(bounds).toEqual({ x: 1230, y: 86, width: 460, height: 840 });
  });

  it("keeps the window on the top edge when the work area cannot fit the preferred bottom gap", () => {
    const bounds = computeInitialMainWindowBounds(
      { x: 0, y: 0, width: 500, height: 650 },
      "win32"
    );

    expect(bounds).toEqual({ x: 30, y: 0, width: 460, height: 650 });
  });

  it("expands chat bounds by the side-panel width while keeping the right edge docked on Windows", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const chat = computeInitialMainWindowBounds(workArea, "win32");
    const expanded = computeChatModeSidePanelBounds(workArea, "win32");

    expect(expanded.width).toBe(chat.width + CHAT_SIDE_PANEL_WIDTH);
    expect(expanded.height).toBe(chat.height);
    expect(expanded.y).toBe(chat.y);
    expect(expanded.x + expanded.width).toBe(chat.x + chat.width);
  });
});
