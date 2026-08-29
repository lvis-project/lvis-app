import { describe, expect, it } from "vitest";
import {
  BAND_LEAD_PAD_DARWIN,
  COLLAPSED_RAIL_RESERVE,
  CONTENT_TITLE_INSET,
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

  it("leaves the rail card room for its inset and a gutter of air before the content", () => {
    // The CSS rail width is reserve − card inset − gutter; it must stay positive.
    expect(COLLAPSED_RAIL_RESERVE - SHELL_GUTTER * 2).toBeGreaterThan(0);
  });
});
