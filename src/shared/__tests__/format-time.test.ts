import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatHhMm, formatMediumDateTime } from "../format-time.js";

// These helpers render in the host zone by design, so the assertions only mean
// something once the host zone is pinned. Node re-reads `TZ` on assignment,
// which moves both `Date` and the `Intl` default.
const INSTANT = Date.UTC(2026, 0, 2, 4, 26);
let previousTz: string | undefined;

beforeEach(() => {
  previousTz = process.env.TZ;
});

afterEach(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("formatHhMm", () => {
  it("returns null when no time was recorded", () => {
    expect(formatHhMm(undefined)).toBeNull();
  });

  it("renders the host-zone hour, not a fixed zone", () => {
    process.env.TZ = "UTC";
    expect(formatHhMm(INSTANT)).toContain("04:26");
    process.env.TZ = "Asia/Seoul";
    expect(formatHhMm(INSTANT)).toContain("01:26");
    process.env.TZ = "America/Los_Angeles";
    expect(formatHhMm(INSTANT)).toContain("08:26");
  });

  it("accepts an ISO string as well as epoch milliseconds", () => {
    process.env.TZ = "UTC";
    expect(formatHhMm(new Date(INSTANT).toISOString())).toBe(formatHhMm(INSTANT));
  });
});

describe("formatMediumDateTime", () => {
  it("renders the host-zone date and time", () => {
    process.env.TZ = "UTC";
    const utc = formatMediumDateTime(INSTANT);
    expect(utc).toContain("2026");
    expect(utc).toContain("4:26");
    // 04:26Z is the previous day in Los Angeles, so the date moves with the zone.
    process.env.TZ = "America/Los_Angeles";
    expect(formatMediumDateTime(INSTANT)).not.toBe(utc);
  });

  it("accepts an ISO string as well as epoch milliseconds", () => {
    process.env.TZ = "UTC";
    expect(formatMediumDateTime(new Date(INSTANT).toISOString()))
      .toBe(formatMediumDateTime(INSTANT));
  });
});
