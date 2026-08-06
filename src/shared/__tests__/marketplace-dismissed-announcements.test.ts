/**
 * `normalizeDismissedAnnouncementIds` — the single definition of "what counts
 * as a valid dismissed announcement id", shared by the renderer (which WRITES
 * `settings.marketplace.dismissedAnnouncementIds`) and main (which FILTERS every
 * announcement push against it).
 *
 * Each assertion below reds when the corresponding clause is dropped from the
 * normalizer; the integration consequences are pinned by
 * `src/boot/__tests__/announcement-check.test.ts` and
 * `src/ui/renderer/hooks/__tests__/use-marketplace-announcements.test.ts`,
 * which now go red on the same single edit.
 */
import { describe, it, expect } from "vitest";
import { normalizeDismissedAnnouncementIds } from "../marketplace-announcements.js";

describe("normalizeDismissedAnnouncementIds", () => {
  it("returns an empty list for anything that is not an array", () => {
    for (const input of [undefined, null, 0, "1,2", { invalid: true }, new Set([1])]) {
      expect(normalizeDismissedAnnouncementIds(input)).toEqual([]);
    }
  });

  it("keeps safe integers", () => {
    expect(normalizeDismissedAnnouncementIds([1, 2, 3])).toEqual([1, 2, 3]);
    expect(normalizeDismissedAnnouncementIds([0, -4])).toEqual([-4, 0]);
  });

  it("drops every non-safe-integer entry", () => {
    const input = [
      1,
      "2",
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      undefined,
      { id: 3 },
      [4],
      true,
    ];
    expect(normalizeDismissedAnnouncementIds(input)).toEqual([1]);
  });

  it("deduplicates", () => {
    expect(normalizeDismissedAnnouncementIds([7, 1, 7, 1, 7])).toEqual([1, 7]);
  });

  it("sorts ascending, numerically — not lexicographically", () => {
    expect(normalizeDismissedAnnouncementIds([10, 9, 2])).toEqual([2, 9, 10]);
  });

  it("is idempotent, which the renderer's write-skip comparison relies on", () => {
    const once = normalizeDismissedAnnouncementIds([7, 1, "x", 7]);
    expect(normalizeDismissedAnnouncementIds(once)).toEqual(once);
  });
});
