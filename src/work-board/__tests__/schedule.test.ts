/**
 * Host-local report bounds. Every assertion pins `TZ` first — these helpers
 * answer "where does the user's day start", so a test that lets the host
 * decide is only checking the machine against itself.
 *
 * 2026-06-16T00:00:00Z is Tue the 16th at 09:00 in Seoul and still Mon the 15th
 * at 17:00 in Los Angeles. The day *key* projection is covered by
 * `shared/__tests__/local-date.test.ts`, which owns it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { localDayBounds, sundayWeekBoundsLocal, isoWeekFor } from "../schedule.js";
import { localDayStart } from "../../shared/local-date.js";

const TUE_JUN16_09_SEOUL = Date.parse("2026-06-16T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
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

describe("schedule (host-local report bounds)", () => {
  it("localDayBounds spans the local day, anchored where the host's midnight is", () => {
    withTz("UTC", () => {
      const b = localDayBounds("2026-06-16");
      expect(new Date(b!.startMs).toISOString()).toBe("2026-06-16T00:00:00.000Z");
      expect(b!.endMs - b!.startMs).toBe(DAY_MS);
    });
    withTz("Asia/Seoul", () => {
      const b = localDayBounds("2026-06-16");
      expect(new Date(b!.startMs).toISOString()).toBe("2026-06-15T15:00:00.000Z");
      expect(b!.endMs - b!.startMs).toBe(DAY_MS);
    });
  });

  it("localDayBounds still spans midnight-to-midnight across a DST transition", () => {
    withTz("America/Los_Angeles", () => {
      // 2026-03-08 springs forward: the civil day is 23 hours long, and the
      // window has to be that day rather than a fixed 24-hour slab.
      const b = localDayBounds("2026-03-08");
      expect(b!.endMs - b!.startMs).toBe(23 * 60 * 60_000);
      expect(new Date(b!.startMs).toISOString()).toBe("2026-03-08T08:00:00.000Z");
      expect(new Date(b!.endMs).toISOString()).toBe("2026-03-09T07:00:00.000Z");
    });
  });

  it("localDayBounds rejects malformed dates", () => {
    expect(localDayBounds("2026-6-16")).toBeNull();
    expect(localDayBounds("not-a-date")).toBeNull();
  });

  it("sundayWeekBoundsLocal anchors on the local Sunday and spans 7 days", () => {
    withTz("Asia/Seoul", () => {
      const { start, end } = sundayWeekBoundsLocal(new Date(TUE_JUN16_09_SEOUL), 0);
      // The Sunday before Tue 2026-06-16 in Seoul is the 14th; its local
      // midnight is 2026-06-13T15:00:00Z.
      expect(start.toISOString()).toBe("2026-06-13T15:00:00.000Z");
      expect(end.getTime() - start.getTime()).toBe(7 * DAY_MS);
    });
  });

  it("sundayWeekBoundsLocal follows the host into a week the fixed anchor would miss", () => {
    withTz("America/Los_Angeles", () => {
      // The same instant is Mon 2026-06-15 in Los Angeles, so its Sunday is the
      // 14th local — 2026-06-14T07:00:00Z, not Seoul's boundary.
      const { start } = sundayWeekBoundsLocal(new Date(TUE_JUN16_09_SEOUL), 0);
      expect(start.toISOString()).toBe("2026-06-14T07:00:00.000Z");
    });
  });

  it("sundayWeekBoundsLocal shifts whole weeks by offset", () => {
    withTz("UTC", () => {
      const thisWeek = sundayWeekBoundsLocal(new Date(TUE_JUN16_09_SEOUL), 0);
      const lastWeek = sundayWeekBoundsLocal(new Date(TUE_JUN16_09_SEOUL), -1);
      expect(thisWeek.start.getTime() - lastWeek.start.getTime()).toBe(7 * DAY_MS);
    });
  });

  it("bounds the day that the panel's own due-date stamp lands in", () => {
    // The panel stamps a picked due date with `localDayStart`; this report
    // counts an item by whether its instant falls inside `localDayBounds`. If
    // those two ever disagree, an item due on the day the report covers falls
    // outside it. Checked in a zone the fixtures were not written for.
    for (const zone of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
      withTz(zone, () => {
        const stamped = localDayStart("2026-06-16")!.getTime();
        const bounds = localDayBounds("2026-06-16")!;
        expect(stamped).toBe(bounds.startMs);
        expect(stamped).toBeLessThan(bounds.endMs);
        // And the day before it is outside, not merely earlier.
        expect(localDayStart("2026-06-15")!.getTime()).toBeLessThan(bounds.startMs);
      });
    }
  });

  it("isoWeekFor labels the week of the local civil day", () => {
    withTz("UTC", () => {
      expect(isoWeekFor(new Date(TUE_JUN16_09_SEOUL))).toBe("2026-W25");
    });
  });
});
