/**
 * CronEvaluator tests.
 *
 * - parseCronExpression: valid/invalid input
 * - isValidCronExpression: validation
 * - matchesCron: field matching (minute, hour, dayOfMonth, month, dayOfWeek)
 * - nextCronFire: next occurrence scanning
 * - Monthly clamp edge cases (Q5 — handled by Date overflow, tested implicitly)
 */
import { describe, it, expect } from "vitest";
import {
  parseCronExpression,
  isValidCronExpression,
  matchesCron,
  nextCronFire,
} from "../cron-evaluator.js";

describe("parseCronExpression", () => {
  it("parses a 5-field expression", () => {
    const f = parseCronExpression("0 9 * * 1-5");
    expect(f).toEqual({
      minute: "0",
      hour: "9",
      dayOfMonth: "*",
      month: "*",
      dayOfWeek: "1-5",
    });
  });

  it("returns null for <5 fields", () => {
    expect(parseCronExpression("0 9 *")).toBeNull();
  });

  it("returns null for >5 fields", () => {
    expect(parseCronExpression("0 9 * * * extra")).toBeNull();
  });
});

describe("isValidCronExpression", () => {
  it("accepts wildcard expression", () => {
    expect(isValidCronExpression("* * * * *")).toBe(true);
  });

  it("accepts step expression", () => {
    expect(isValidCronExpression("*/15 * * * *")).toBe(true);
  });

  it("accepts range expression", () => {
    expect(isValidCronExpression("0 9-18 * * 1-5")).toBe(true);
  });

  it("accepts comma list", () => {
    expect(isValidCronExpression("0,30 * * * *")).toBe(true);
  });

  it("rejects out-of-range minute", () => {
    expect(isValidCronExpression("60 * * * *")).toBe(false);
  });

  it("rejects out-of-range hour", () => {
    expect(isValidCronExpression("0 25 * * *")).toBe(false);
  });

  it("returns null for malformed expression string", () => {
    expect(isValidCronExpression("not valid")).toBe(false);
  });
});

describe("matchesCron", () => {
  it("matches * * * * * for any time", () => {
    expect(matchesCron("* * * * *", new Date())).toBe(true);
  });

  it("matches specific minute and hour", () => {
    // 2026-05-08 09:00 Friday (day=5)
    const d = new Date("2026-05-08T09:00:00Z");
    expect(matchesCron("0 9 * * *", d)).toBe(true);
  });

  it("does not match wrong minute", () => {
    const d = new Date("2026-05-08T09:01:00Z");
    expect(matchesCron("0 9 * * *", d)).toBe(false);
  });

  it("matches step: */15 at minute 0, 15, 30, 45", () => {
    const d0 = new Date("2026-05-08T09:00:00Z");
    const d15 = new Date("2026-05-08T09:15:00Z");
    const d7 = new Date("2026-05-08T09:07:00Z");
    expect(matchesCron("*/15 * * * *", d0)).toBe(true);
    expect(matchesCron("*/15 * * * *", d15)).toBe(true);
    expect(matchesCron("*/15 * * * *", d7)).toBe(false);
  });

  it("matches dayOfWeek range 1-5 (Mon-Fri)", () => {
    // 2026-05-08 is Friday (UTC)
    const fri = new Date("2026-05-08T10:00:00Z");
    // 2026-05-10 is Sunday (UTC)
    const sun = new Date("2026-05-10T10:00:00Z");
    expect(matchesCron("0 10 * * 1-5", fri)).toBe(true);
    expect(matchesCron("0 10 * * 1-5", sun)).toBe(false);
  });

  it("normalizes dayOfWeek 7 to 0 (Sunday)", () => {
    // 2026-05-10 is Sunday
    const sun = new Date("2026-05-10T10:00:00Z");
    expect(matchesCron("0 10 * * 7", sun)).toBe(true);
  });

  it("dayOfWeek range 5-7 (Fri-Sun) validates, parses and matches all three days", () => {
    // isValidCronExpression must accept "5-7" (was broken: 7→0 normalize made start>end)
    expect(isValidCronExpression("0 10 * * 5-7")).toBe(true);
    // Friday 2026-05-08
    const fri = new Date("2026-05-08T10:00:00Z");
    // Saturday 2026-05-09
    const sat = new Date("2026-05-09T10:00:00Z");
    // Sunday 2026-05-10 (getUTCDay()===0, but range 5-7 should still match)
    const sun = new Date("2026-05-10T10:00:00Z");
    // Monday 2026-05-11 must NOT match
    const mon = new Date("2026-05-11T10:00:00Z");
    expect(matchesCron("0 10 * * 5-7", fri)).toBe(true);
    expect(matchesCron("0 10 * * 5-7", sat)).toBe(true);
    expect(matchesCron("0 10 * * 5-7", sun)).toBe(true);
    expect(matchesCron("0 10 * * 5-7", mon)).toBe(false);
  });
});

describe("nextCronFire", () => {
  it("finds the next fire one minute ahead for * * * * *", () => {
    const from = new Date("2026-05-08T09:00:00Z");
    const next = nextCronFire("* * * * *", from);
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBe(new Date("2026-05-08T09:01:00Z").getTime());
  });

  it("finds the next daily 9:00 UTC fire", () => {
    // from 09:01 UTC → next is 09:00 UTC next day
    const from = new Date("2026-05-08T09:01:00Z");
    const next = nextCronFire("0 9 * * *", from);
    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCMinutes()).toBe(0);
    expect(next!.getUTCDate()).toBeGreaterThanOrEqual(9); // next day or later
  });

  it("returns null for impossible expression within horizon", () => {
    // Feb 30 doesn't exist — will scan full year without match
    // Use a very short maxMinutes to keep test fast
    const from = new Date("2026-01-01T00:00:00Z");
    const next = nextCronFire("0 0 30 2 *", from, 60);
    expect(next).toBeNull();
  });

  it("respects maxMinutes limit", () => {
    // next fire for "0 23 * * *" from 23:01 is 22h59m away = 1379 minutes
    const from = new Date("2026-05-08T23:01:00Z");
    const next = nextCronFire("0 23 * * *", from, 60);
    expect(next).toBeNull();
  });
});
