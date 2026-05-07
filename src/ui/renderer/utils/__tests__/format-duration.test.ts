import { describe, expect, it } from "vitest";
import { formatToolDuration } from "../format-duration.js";

describe("formatToolDuration", () => {
  it("returns '<0.1s' for sub-100ms calls", () => {
    expect(formatToolDuration(0)).toBe("<0.1s");
    expect(formatToolDuration(50)).toBe("<0.1s");
    expect(formatToolDuration(99)).toBe("<0.1s");
  });

  it("formats sub-minute durations as 'X.Ys'", () => {
    expect(formatToolDuration(100)).toBe("0.1s");
    expect(formatToolDuration(300)).toBe("0.3s");
    expect(formatToolDuration(1400)).toBe("1.4s");
    expect(formatToolDuration(59_999)).toBe("60.0s");
  });

  it("formats minute+ durations as 'Xm Y.Zs'", () => {
    expect(formatToolDuration(60_000)).toBe("1m 0.0s");
    expect(formatToolDuration(72_400)).toBe("1m 12.4s");
    expect(formatToolDuration(125_500)).toBe("2m 5.5s");
  });

  it("returns empty string for invalid input", () => {
    expect(formatToolDuration(Number.NaN)).toBe("");
    expect(formatToolDuration(-1)).toBe("");
    expect(formatToolDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
});
