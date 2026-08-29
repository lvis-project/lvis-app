/**
 * These helpers project onto the HOST's civil calendar, so every assertion has
 * to pin the zone or it asserts nothing beyond "the machine running the suite
 * agrees with itself". Node re-reads `TZ` on assignment, for both `Date` and
 * the `Intl` default.
 *
 * 2026-06-16T00:00:00Z is Tue the 16th at 09:00 in Seoul and still Mon the 15th
 * at 17:00 in Los Angeles — one instant, two civil days, which is the whole
 * thing these helpers decide.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  localDateKey,
  localDayRange,
  localDayStart,
  localMondayWeekStartKey,
  localMonthStartKey,
  shiftLocalDateKey,
} from "../local-date.js";

const TUE_JUN16_09_SEOUL = Date.parse("2026-06-16T00:00:00.000Z");
let previousTz: string | undefined;

function withTz<T>(zone: string, run: () => T): T {
  process.env.TZ = zone;
  return run();
}

beforeEach(() => {
  previousTz = process.env.TZ;
});

afterEach(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("localDateKey", () => {
  it("projects an instant onto the host's civil day, not a fixed zone's", () => {
    const instant = new Date(TUE_JUN16_09_SEOUL);
    expect(withTz("Asia/Seoul", () => localDateKey(instant))).toBe("2026-06-16");
    expect(withTz("UTC", () => localDateKey(instant))).toBe("2026-06-16");
    expect(withTz("America/Los_Angeles", () => localDateKey(instant))).toBe("2026-06-15");
  });

  it("pads month and day", () => {
    withTz("UTC", () => {
      expect(localDateKey(new Date(Date.parse("2026-01-02T12:00:00.000Z")))).toBe("2026-01-02");
    });
  });

  it("follows the local midnight boundary in a zone behind UTC", () => {
    withTz("America/Los_Angeles", () => {
      // 07:00Z is 00:00 local on the 16th (PDT, UTC-7) — the day has just turned.
      expect(localDateKey(new Date(Date.parse("2026-06-16T07:00:00.000Z")))).toBe("2026-06-16");
      expect(localDateKey(new Date(Date.parse("2026-06-16T06:59:00.000Z")))).toBe("2026-06-15");
    });
  });
});

describe("localDayStart", () => {
  it("returns the instant the local day begins", () => {
    withTz("UTC", () => {
      expect(localDayStart("2026-06-16")?.toISOString()).toBe("2026-06-16T00:00:00.000Z");
    });
    withTz("Asia/Seoul", () => {
      expect(localDayStart("2026-06-16")?.toISOString()).toBe("2026-06-15T15:00:00.000Z");
    });
  });

  it("round-trips with localDateKey in any zone", () => {
    for (const zone of ["UTC", "Asia/Seoul", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      withTz(zone, () => {
        const start = localDayStart("2026-06-16");
        expect(start).not.toBeNull();
        expect(localDateKey(start as Date)).toBe("2026-06-16");
      });
    }
  });

  it("does not fold a two-digit-looking year onto 1900", () => {
    withTz("UTC", () => {
      expect(localDateKey(localDayStart("0099-01-01") as Date)).toBe("0099-01-01");
    });
  });

  it("returns null for a malformed key", () => {
    expect(localDayStart("2026-6-16")).toBeNull();
    expect(localDayStart("not-a-date")).toBeNull();
  });
});

describe("shiftLocalDateKey", () => {
  it("moves whole days and crosses month and year ends", () => {
    expect(shiftLocalDateKey("2026-06-16", -1)).toBe("2026-06-15");
    expect(shiftLocalDateKey("2026-07-01", -1)).toBe("2026-06-30");
    expect(shiftLocalDateKey("2025-12-31", 1)).toBe("2026-01-01");
  });

  it("is unaffected by the host zone, including across a DST transition", () => {
    // 2026-03-08 is the US spring-forward day; a 23-hour day must not swallow one.
    for (const zone of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
      withTz(zone, () => {
        expect(shiftLocalDateKey("2026-03-07", 1)).toBe("2026-03-08");
        expect(shiftLocalDateKey("2026-03-08", 1)).toBe("2026-03-09");
      });
    }
  });

  it("returns a malformed key unchanged", () => {
    expect(shiftLocalDateKey("2026-6-16", 1)).toBe("2026-6-16");
  });

  it("keeps a two-digit year in its own century instead of landing in the 1900s", () => {
    // `Date.UTC(99, …)` means 1999, so an uncorrected shift turned a year-99
    // key into a year-1999 one — and `localDayRange` then opened a window
    // nineteen centuries wide instead of the one day that was asked for.
    expect(shiftLocalDateKey("0099-01-01", 1)).toBe("0099-01-02");
    expect(shiftLocalDateKey("0099-12-31", 1)).toBe("0100-01-01");
    expect(shiftLocalDateKey("0100-01-01", -1)).toBe("0099-12-31");
  });

  it("keeps a leap day in a leap year the placeholder cannot borrow from", () => {
    // Year 96 is a leap year; the seeding year must not decide that for it.
    expect(shiftLocalDateKey("0096-02-28", 1)).toBe("0096-02-29");
    expect(shiftLocalDateKey("0097-02-28", 1)).toBe("0097-03-01");
  });
});

describe("localDayRange", () => {
  it("stays one day wide when the year has two digits", () => {
    // The range is built from `shiftLocalDateKey(toKey, 1)`, so a year that
    // slipped into the 1900s here would not just be mislabelled — it would open
    // a window nineteen centuries wide and hand back every row ever written.
    withTz("UTC", () => {
      const range = localDayRange("0099-01-01", "0099-01-01");
      expect(range).not.toBeNull();
      expect(range!.end!.getTime() - range!.start!.getTime()).toBe(24 * 60 * 60 * 1000);
    });
  });
});

describe("week and month anchors", () => {
  it("localMondayWeekStartKey anchors on Monday, not the Work Board's Sunday", () => {
    withTz("UTC", () => {
      // Tue 2026-06-16: the Monday before it is the 15th, the Sunday the 14th.
      expect(localMondayWeekStartKey(new Date(TUE_JUN16_09_SEOUL))).toBe("2026-06-15");
    });
  });

  it("localMondayWeekStartKey treats Sunday as the end of the week it closes", () => {
    withTz("UTC", () => {
      // Sun 2026-06-14 belongs to the week that began Mon the 8th.
      expect(localMondayWeekStartKey(new Date(Date.parse("2026-06-14T00:00:00.000Z"))))
        .toBe("2026-06-08");
    });
  });

  it("localMonthStartKey returns the first of the local month", () => {
    const lastInstantOfJune = new Date(Date.parse("2026-06-30T16:00:00.000Z"));
    expect(withTz("UTC", () => localMonthStartKey(lastInstantOfJune))).toBe("2026-06-01");
    // Same instant is already July 1st in Seoul.
    expect(withTz("Asia/Seoul", () => localMonthStartKey(lastInstantOfJune))).toBe("2026-07-01");
  });
});
