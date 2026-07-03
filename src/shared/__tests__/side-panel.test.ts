import { describe, expect, it } from "vitest";
import {
  SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  SIDE_PANEL_SPLIT_MAX_PERCENT,
  SIDE_PANEL_SPLIT_MIN_PERCENT,
  clampSidePanelSplitPercent,
} from "../side-panel.js";

describe("clampSidePanelSplitPercent", () => {
  it("clamps below the minimum up to MIN", () => {
    expect(clampSidePanelSplitPercent(5)).toBe(SIDE_PANEL_SPLIT_MIN_PERCENT);
  });

  it("clamps above the maximum down to MAX", () => {
    expect(clampSidePanelSplitPercent(95)).toBe(SIDE_PANEL_SPLIT_MAX_PERCENT);
  });

  it("rounds an in-range fractional value", () => {
    expect(clampSidePanelSplitPercent(45.6)).toBe(46);
    expect(clampSidePanelSplitPercent(45.4)).toBe(45);
  });

  it("clamps THEN rounds so the result is a whole number inside [MIN, MAX]", () => {
    // A fractional value just above MAX must land exactly on MAX, not MAX+1.
    const result = clampSidePanelSplitPercent(SIDE_PANEL_SPLIT_MAX_PERCENT + 0.4);
    expect(result).toBe(SIDE_PANEL_SPLIT_MAX_PERCENT);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("falls back to the default for non-finite input (NaN / Infinity)", () => {
    expect(clampSidePanelSplitPercent(Number.NaN)).toBe(SIDE_PANEL_SPLIT_DEFAULT_PERCENT);
    expect(clampSidePanelSplitPercent(Number.POSITIVE_INFINITY)).toBe(SIDE_PANEL_SPLIT_DEFAULT_PERCENT);
    expect(clampSidePanelSplitPercent(Number.NEGATIVE_INFINITY)).toBe(SIDE_PANEL_SPLIT_DEFAULT_PERCENT);
  });
});
