import { describe, expect, it } from "vitest";
import { FONT_SIZE_SCALE_VALUES } from "../appearance-font.js";
import {
  BAND_LEAD_PAD_DARWIN,
  COLLAPSED_RAIL_RESERVE,
  CONTENT_TITLE_INSET,
  RAIL_CONTROL_REM,
  SHELL_GUTTER,
} from "../shell-geometry.js";

/**
 * `COLLAPSED_RAIL_RESERVE` is a literal so the CSS mirror gate can read it as
 * source text, which means nothing in the module itself ties it to the lights.
 * This is that tie: the band clamps its lead pad to `BAND_LEAD_PAD_DARWIN`, the
 * collapsed content title sits `CONTENT_TITLE_INSET` past the reserve, and the
 * path lines up with the title only when the two sums agree.
 */
describe("shell geometry: collapsed rail reserve", () => {
  it("puts the collapsed content title exactly where the darwin band's path may start", () => {
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
