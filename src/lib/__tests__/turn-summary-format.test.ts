import { describe, it, expect } from "vitest";
import { formatDuration, formatTokens } from "../turn-summary-format.js";

describe("formatDuration", () => {
  it("returns 0s for zero / negative / non-finite inputs", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-100)).toBe("0s");
    expect(formatDuration(NaN)).toBe("0s");
    expect(formatDuration(Infinity)).toBe("0s");
  });

  it("returns <0.1s for sub-100ms durations", () => {
    expect(formatDuration(50)).toBe("<0.1s");
    expect(formatDuration(99)).toBe("<0.1s");
  });

  it("formats sub-minute durations as X.Xs", () => {
    expect(formatDuration(1_400)).toBe("1.4s");
    expect(formatDuration(12_700)).toBe("12.7s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  it("formats minute-scale durations as Xm Y[.Z]s", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(72_400)).toBe("1m 12.4s");
    expect(formatDuration(252_700)).toBe("4m 12.7s");
  });

  it("formats hour-scale durations as Xh YYm", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
    expect(formatDuration(7_500_000)).toBe("2h 05m");
  });
});

describe("formatTokens", () => {
  it("returns 0 for zero / negative / non-finite", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-50)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });

  it("returns plain integer below 1k", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  it("returns X.Xk for thousands range", () => {
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(47_300)).toBe("47.3k");
    expect(formatTokens(999_400)).toBe("999.4k");
  });

  it("returns X.XM for millions range", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(47_300_000)).toBe("47.3M");
  });
});
