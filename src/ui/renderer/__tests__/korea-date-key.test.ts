import { describe, it, expect } from "vitest";
import { getKoreaDateKey } from "../utils/korea-date-key.js";

describe("getKoreaDateKey (Asia/Seoul, UTC+9)", () => {
  const cases: Array<[string, string]> = [
    // 10:00 UTC -> 19:00 KST, same calendar day
    ["2026-01-15T10:00:00Z", "2026-01-15"],
    // 15:30 UTC -> 00:30 KST next day (crosses midnight)
    ["2026-01-15T15:30:00Z", "2026-01-16"],
    // 20:00 UTC on Jun 30 -> 05:00 KST Jul 1
    ["2026-06-30T20:00:00Z", "2026-07-01"],
    // year rollover: 23:00 UTC Dec 31 -> 08:00 KST Jan 1
    ["2026-12-31T23:00:00Z", "2027-01-01"],
  ];

  it.each(cases)("getKoreaDateKey(%s) -> %s", (iso, expected) => {
    expect(getKoreaDateKey(new Date(iso))).toBe(expected);
  });

  it("zero-pads month and day to two digits", () => {
    expect(getKoreaDateKey(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03-05");
  });
});
