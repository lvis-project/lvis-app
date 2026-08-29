/**
 * The fixed instant 2026-06-16T00:00:00Z is 2026-06-16 09:00 KST (a Tuesday),
 * so every projection below is checkable by hand against the KST wall clock.
 */
import { describe, expect, it } from "vitest";

import {
  KST_OFFSET_MS,
  kstDateKey,
  kstMondayWeekStartKey,
  kstMonthStartKey,
  shiftKstDateKey,
} from "../kst-date.js";

const TUE_JUN16 = Date.parse("2026-06-16T00:00:00.000Z"); // 09:00 KST, Tue

describe("kstDateKey", () => {
  it("projects an instant onto the KST civil day", () => {
    expect(kstDateKey(new Date(TUE_JUN16))).toBe("2026-06-16");
    // 2026-06-15T16:00Z = 2026-06-16 01:00 KST → already the 16th.
    expect(kstDateKey(new Date(Date.parse("2026-06-15T16:00:00.000Z")))).toBe("2026-06-16");
    // 2026-06-15T14:00Z = 2026-06-15 23:00 KST → still the 15th.
    expect(kstDateKey(new Date(Date.parse("2026-06-15T14:00:00.000Z")))).toBe("2026-06-15");
  });

  it("uses the exported offset the Work Board bounds are derived from", () => {
    expect(KST_OFFSET_MS).toBe(9 * 60 * 60 * 1000);
  });
});

describe("shiftKstDateKey", () => {
  it("moves whole days and crosses month and year ends", () => {
    expect(shiftKstDateKey("2026-06-16", -1)).toBe("2026-06-15");
    expect(shiftKstDateKey("2026-07-01", -1)).toBe("2026-06-30");
    expect(shiftKstDateKey("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("returns a malformed key unchanged", () => {
    expect(shiftKstDateKey("2026-6-16", 1)).toBe("2026-6-16");
  });
});

describe("week and month anchors", () => {
  it("kstMondayWeekStartKey anchors on Monday, not the Work Board's Sunday", () => {
    // Tue 2026-06-16 KST: the Monday before it is the 15th, the Sunday the 14th.
    expect(kstMondayWeekStartKey(new Date(TUE_JUN16))).toBe("2026-06-15");
  });

  it("kstMondayWeekStartKey treats Sunday as the end of the week it closes", () => {
    // Sun 2026-06-14 09:00 KST belongs to the week that began Mon the 8th.
    expect(kstMondayWeekStartKey(new Date(Date.parse("2026-06-14T00:00:00.000Z"))))
      .toBe("2026-06-08");
  });

  it("kstMonthStartKey returns the first of the KST month", () => {
    expect(kstMonthStartKey(new Date(TUE_JUN16))).toBe("2026-06-01");
    // 2026-06-30T16:00Z is already 2026-07-01 in KST.
    expect(kstMonthStartKey(new Date(Date.parse("2026-06-30T16:00:00.000Z"))))
      .toBe("2026-07-01");
  });
});
