/**
 * Re-anchoring due dates that were stamped as midnight in a fixed zone.
 *
 * The board used to write a picked day as `${day}T00:00:00+09:00`. That is an
 * absolute instant, so nothing on disk changed meaning when the board moved to
 * the host calendar — but the day it DISPLAYS under did, and the user picked a
 * day. These tests pin which values move and which are left exactly alone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { normalizeBoardDueDates, normalizeDueAt } from "../board-file.js";
import { localDateKey } from "../../shared/local-date.js";
import type { WorkItem } from "../../shared/work-board-types.js";

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

// What the old panel wrote for a user who picked 2026-06-16.
const KST_MIDNIGHT_JUN16 = "2026-06-16T00:00:00+09:00";

describe("normalizeDueAt", () => {
  it("keeps the picked day on a host west of where it was stamped", () => {
    withTz("America/Los_Angeles", () => {
      // Untouched, this instant is 2026-06-15 09:00 in Los Angeles — the picker
      // would show the 15th for a date the user set to the 16th.
      expect(localDateKey(new Date(KST_MIDNIGHT_JUN16))).toBe("2026-06-15");

      const normalized = normalizeDueAt(KST_MIDNIGHT_JUN16);
      expect(localDateKey(new Date(normalized))).toBe("2026-06-16");
      // And it is that day's local midnight, not merely somewhere inside it.
      expect(normalized).toBe("2026-06-16T07:00:00.000Z");
    });
  });

  it("leaves a due date that carries a real time of day alone", () => {
    withTz("America/Los_Angeles", () => {
      // 14:30 in Seoul was never a day-picker value; its instant is the point.
      const withTime = "2026-06-16T14:30:00+09:00";
      expect(normalizeDueAt(withTime)).toBe(withTime);
    });
  });

  it("leaves a value already anchored to the host's own offset alone", () => {
    withTz("Asia/Seoul", () => {
      expect(normalizeDueAt(KST_MIDNIGHT_JUN16)).toBe(KST_MIDNIGHT_JUN16);
    });
  });

  it("leaves a value with no explicit offset alone", () => {
    withTz("America/Los_Angeles", () => {
      // Nothing says what zone the writer meant, so guessing would be inventing.
      expect(normalizeDueAt("2026-06-16T00:00:00")).toBe("2026-06-16T00:00:00");
    });
  });

  it("leaves an unparseable value alone", () => {
    withTz("UTC", () => {
      expect(normalizeDueAt("not-a-date+09:00")).toBe("not-a-date+09:00");
    });
  });

  it("is idempotent — a second pass moves nothing", () => {
    for (const zone of ["America/Los_Angeles", "Asia/Seoul", "UTC", "Europe/London"]) {
      withTz(zone, () => {
        const once = normalizeDueAt(KST_MIDNIGHT_JUN16);
        expect(normalizeDueAt(once)).toBe(once);
        // And the day survives every extra pass, which is the actual invariant.
        expect(localDateKey(new Date(once))).toBe("2026-06-16");
      });
    }
  });
});

describe("normalizeBoardDueDates", () => {
  function item(id: number, due_at?: string): WorkItem {
    return {
      id,
      title: `item ${id}`,
      status: "planned",
      priority: "medium",
      created_at: "2026-06-16T01:00:00.000Z",
      updated_at: "2026-06-16T01:00:00.000Z",
      ...(due_at === undefined ? {} : { due_at }),
    };
  }

  it("counts only the rows it actually moved", () => {
    withTz("America/Los_Angeles", () => {
      const { items, changed } = normalizeBoardDueDates([
        item(1, KST_MIDNIGHT_JUN16),
        item(2, "2026-06-16T14:30:00+09:00"),
        item(3),
      ]);

      expect(changed).toBe(1);
      expect(localDateKey(new Date(items[0].due_at as string))).toBe("2026-06-16");
      expect(items[1].due_at).toBe("2026-06-16T14:30:00+09:00");
      expect(items[2].due_at).toBeUndefined();
    });
  });

  it("reports nothing to do on a host in the zone the rows were stamped in", () => {
    withTz("Asia/Seoul", () => {
      const { changed } = normalizeBoardDueDates([item(1, KST_MIDNIGHT_JUN16)]);
      expect(changed).toBe(0);
    });
  });
});
