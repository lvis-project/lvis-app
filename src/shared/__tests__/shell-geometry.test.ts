import { describe, expect, it } from "vitest";
import { FONT_SIZE_SCALE_VALUES } from "../appearance-font.js";
import {
  BAND_EDGE_PAD,
  BAND_LEAD_PAD_DARWIN,
  CHROME_GAP_HAIR,
  CHROME_GAP_TIGHT,
  CHROME_ICON_BUTTON,
  CLUSTER_LEAD_PAD_DARWIN,
  COLLAPSED_RAIL_RESERVE,
  CONTENT_TITLE_INSET,
  RAIL_CONTROL_REM,
  SHELL_GUTTER,
  collapsedBandLeadClearance,
} from "../shell-geometry.js";

/**
 * `COLLAPSED_RAIL_RESERVE` is a literal so the CSS mirror gate can read it as
 * source text, which means nothing in the module itself ties it to the lights.
 * This is that tie: the band clamps its lead pad to `BAND_LEAD_PAD_DARWIN`, the
 * collapsed content title sits `CONTENT_TITLE_INSET` past the reserve, and the
 * title lands on that lead line only when the two sums agree.
 */
describe("shell geometry: collapsed rail reserve", () => {
  it("puts the collapsed content title exactly on the darwin band's lead line", () => {
    expect(COLLAPSED_RAIL_RESERVE + CONTENT_TITLE_INSET).toBe(BAND_LEAD_PAD_DARWIN);
  });

  it("leaves the rail card room for its widest control at the largest font scale", () => {
    // The CSS rail width is reserve − card inset − gutter (`RAIL_CONTROL_REM`
    // px-equivalent below, since px never follows the type scale): the compact
    // rail's widest control — `RAIL_CONTROL_SIZE_CLASS` (`h-9 w-9`) in
    // `Sidebar.tsx` — has to fit inside it even when the user picks the
    // largest entry in `FONT_SIZE_SCALE_VALUES`, not merely stay positive.
    const widestRailControlPx = RAIL_CONTROL_REM * 16 * Math.max(...FONT_SIZE_SCALE_VALUES);
    expect(COLLAPSED_RAIL_RESERVE - SHELL_GUTTER * 2).toBeGreaterThanOrEqual(widestRailControlPx);
  });
});

/**
 * While the rail is collapsed the sidebar's cluster strip (toggle, search,
 * back, forward) stands bare on the band line, so the band's path has to
 * start past the strip, not at the lights' line where the strip begins.
 */
describe("shell geometry: collapsed band lead clearance", () => {
  const stripRun = 4 * CHROME_ICON_BUTTON + 3 * CHROME_GAP_HAIR;

  it("clears the four-control strip by one gutter on darwin, past the traffic lights", () => {
    const firstButtonX = SHELL_GUTTER + CLUSTER_LEAD_PAD_DARWIN;
    expect(collapsedBandLeadClearance(true)).toBe(firstButtonX + stripRun + SHELL_GUTTER);
    // Strictly past the band's own lead pad, or `Math.max` in CustomTitleBar
    // would put the path back under the strip.
    expect(collapsedBandLeadClearance(true)).toBeGreaterThan(BAND_LEAD_PAD_DARWIN);
  });

  it("clears the strip from the card inset plus its tight pad elsewhere", () => {
    const firstButtonX = SHELL_GUTTER + CHROME_GAP_TIGHT;
    expect(collapsedBandLeadClearance(false)).toBe(firstButtonX + stripRun + SHELL_GUTTER);
    expect(collapsedBandLeadClearance(false)).toBeGreaterThan(BAND_EDGE_PAD);
  });
});
