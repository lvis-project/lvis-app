import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatClockTime,
  formatDateTime,
  formatHhMm,
  formatLocalIsoWithOffset,
  formatMediumDateTime,
  formatMonthYear,
  formatRelativeTime,
  hostTimeZone,
  type RelativeTimeLabels,
} from "../format-time.js";

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

describe("formatRelativeTime", () => {
  const labels: RelativeTimeLabels = {
    justNow: () => "now",
    minutesAgo: (n) => `${n}m`,
    hoursAgo: (n) => `${n}h`,
    daysAgo: (n) => `${n}d`,
  };
  const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buckets by floored seconds, minutes, hours, then days", () => {
    expect(formatRelativeTime(NOW - 59_000, labels)).toBe("now");
    expect(formatRelativeTime(NOW - 60_000, labels)).toBe("1m");
    expect(formatRelativeTime(NOW - 59 * 60_000 - 59_000, labels)).toBe("59m");
    expect(formatRelativeTime(NOW - 60 * 60_000, labels)).toBe("1h");
    expect(formatRelativeTime(NOW - 23 * 3_600_000, labels)).toBe("23h");
    expect(formatRelativeTime(NOW - 24 * 3_600_000, labels)).toBe("1d");
    expect(formatRelativeTime(new Date(NOW - 3 * 86_400_000).toISOString(), labels)).toBe("3d");
  });

  it("uses the sub-minute label only when the surface provides one", () => {
    expect(formatRelativeTime(NOW - 30_000, { ...labels, secondsAgo: (n) => `${n}s` })).toBe("30s");
    expect(formatRelativeTime(NOW - 30_000, labels)).toBe("now");
  });

  it("clamps a future instant to just-now and renders nothing for an unparseable one", () => {
    expect(formatRelativeTime(NOW + 5_000, labels)).toBe("now");
    expect(formatRelativeTime("not a date", labels)).toBe("");
  });

  it("renders nothing rather than throwing when a label throws", () => {
    const throwing: RelativeTimeLabels = { ...labels, minutesAgo: () => { throw new Error("no catalog"); } };
    expect(formatRelativeTime(NOW - 5 * 60_000, throwing)).toBe("");
  });
});

describe("formatLocalIsoWithOffset", () => {
  it("renders the local wall clock with the numeric offset of that instant", () => {
    process.env.TZ = "Asia/Seoul";
    expect(formatLocalIsoWithOffset(new Date(INSTANT))).toBe("2026-01-02T13:26:00+09:00");
    process.env.TZ = "America/Los_Angeles";
    expect(formatLocalIsoWithOffset(new Date(INSTANT))).toBe("2026-01-01T20:26:00-08:00");
    process.env.TZ = "UTC";
    expect(formatLocalIsoWithOffset(new Date(INSTANT))).toBe("2026-01-02T04:26:00+00:00");
  });
});

describe("host-zone locale styles", () => {
  it("hostTimeZone follows TZ", () => {
    process.env.TZ = "Asia/Seoul";
    expect(hostTimeZone()).toBe("Asia/Seoul");
  });

  it("formatClockTime and formatDateTime render in the host zone", () => {
    process.env.TZ = "UTC";
    expect(formatClockTime(INSTANT)).toContain("4:26");
    expect(formatDateTime(INSTANT)).toContain("2026");
    expect(formatDateTime(INSTANT)).toContain("4:26");
    expect(formatClockTime(new Date(INSTANT).toISOString())).toBe(formatClockTime(INSTANT));
  });

  it("formatMonthYear renders the month heading in the requested locale", () => {
    process.env.TZ = "UTC";
    expect(formatMonthYear(INSTANT, "en-US")).toBe("January 2026");
    expect(formatMonthYear(INSTANT, "ko-KR")).toContain("2026");
  });
});
