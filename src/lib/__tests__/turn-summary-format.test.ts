import { describe, it, expect } from "vitest";
import { formatBytes, formatDuration } from "../turn-summary-format.js";

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

describe("formatBytes", () => {
  it("returns 0 B for zero / negative / non-finite inputs", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("prints a raw count below one kilobyte", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to KB at exactly 1024 bytes, with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4_800)).toBe("4.7 KB");
    expect(formatBytes(241_400)).toBe("235.7 KB");
  });

  it("switches to MB at exactly 1 MiB, with one decimal", () => {
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatBytes(13_000_000)).toBe("12.4 MB");
  });

  it("switches to GB at exactly 1 GiB, with one decimal", () => {
    expect(formatBytes(1_073_741_824)).toBe("1.0 GB");
    expect(formatBytes(2_500_000_000)).toBe("2.3 GB");
  });
});
