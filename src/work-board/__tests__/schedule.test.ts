/**
 * KST report bounds. The fixed instant 2026-06-16T00:00:00Z is 2026-06-16
 * 09:00 KST (a Tuesday), so day/week projections are checkable by hand against
 * the KST wall clock. The day *key* projection is covered by
 * `shared/__tests__/kst-date.test.ts`, which now owns it.
 */
import { describe, it, expect } from "vitest";
import { kstDayBounds, sundayWeekBoundsKst, isoWeekFor } from "../schedule.js";

const UTC_MIDNIGHT_JUN16 = Date.parse("2026-06-16T00:00:00.000Z"); // 09:00 KST, Tue

describe("schedule (KST helpers)", () => {
  it("kstDayBounds spans exactly one KST day in UTC", () => {
    const b = kstDayBounds("2026-06-16");
    expect(b).not.toBeNull();
    // KST midnight 2026-06-16 == 2026-06-15T15:00:00Z.
    expect(new Date(b!.startMs).toISOString()).toBe("2026-06-15T15:00:00.000Z");
    expect(b!.endMs - b!.startMs).toBe(24 * 60 * 60_000);
  });

  it("kstDayBounds rejects malformed dates", () => {
    expect(kstDayBounds("2026-6-16")).toBeNull();
    expect(kstDayBounds("not-a-date")).toBeNull();
  });

  it("sundayWeekBoundsKst anchors on the KST Sunday and spans 7 days", () => {
    const { start, end } = sundayWeekBoundsKst(new Date(UTC_MIDNIGHT_JUN16), 0);
    // The Sunday before Tue 2026-06-16 KST is 2026-06-14; its KST midnight is
    // 2026-06-13T15:00:00Z.
    expect(start.toISOString()).toBe("2026-06-13T15:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60_000);
  });

  it("sundayWeekBoundsKst shifts whole weeks by offset", () => {
    const thisWeek = sundayWeekBoundsKst(new Date(UTC_MIDNIGHT_JUN16), 0);
    const lastWeek = sundayWeekBoundsKst(new Date(UTC_MIDNIGHT_JUN16), -1);
    expect(thisWeek.start.getTime() - lastWeek.start.getTime()).toBe(7 * 24 * 60 * 60_000);
  });

  it("isoWeekFor returns a YYYY-Www label", () => {
    expect(isoWeekFor(new Date(UTC_MIDNIGHT_JUN16))).toMatch(/^2026-W\d{2}$/);
  });
});
