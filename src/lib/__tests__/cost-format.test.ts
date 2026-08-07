/**
 * `formatTokens` is the single authority for compact token counts on the
 * renderer's usage surfaces. These are exact rendered strings on purpose: the
 * two private copies this module replaced disagreed on decimals and rendered
 * `"InfinityM"`, `"NaN"` and `"-50"` to the user, and only exact assertions can
 * catch that coming back.
 */
import { describe, expect, it } from "vitest";
import { formatCost, formatTokens } from "../cost-format.js";

describe("formatTokens", () => {
  it("collapses non-finite and non-positive counts to 0 instead of leaking a raw number", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-50)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatTokens(Number.NEGATIVE_INFINITY)).toBe("0");
  });

  it("renders a rounded integer below 1k", () => {
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(42.7)).toBe("43");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(999.4)).toBe("999");
  });

  it("renders X.Xk in the thousands range", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(2_000)).toBe("2.0k");
    expect(formatTokens(47_300)).toBe("47.3k");
    expect(formatTokens(999_400)).toBe("999.4k");
  });

  it("renders X.XM at and above a million — one decimal, not two", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(47_300_000)).toBe("47.3M");
    expect(formatTokens(Number.MAX_SAFE_INTEGER)).toBe("9007199254.7M");
  });
});

/**
 * The ladder widens precision as the amount shrinks. These are exact strings
 * because the four copies this replaced each cut off at a different decimal,
 * so the same amount read `$0.50`, `$0.500` and `$0.5` on three screens.
 */
describe("formatCost", () => {
  it("renders exact cost strings across the whole ladder", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0005)).toBe("$0.00050");
    expect(formatCost(0.005)).toBe("$0.0050");
    expect(formatCost(0.05)).toBe("$0.050");
    expect(formatCost(0.5)).toBe("$0.500");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(1234.5)).toBe("$1,234.50");
  });

  // The starred-session list grouped via `Intl` before this consolidation.
  // Dropping the separator would have been the one change here that made a
  // number harder to read, so the unified formatter keeps it and the other
  // three surfaces gain it. Grouping is pinned to en-US regardless of UI
  // locale — costs are USD everywhere, and the locale-shaped `1234,50 $` the
  // starred view used to render was the outlier being removed.
  it("groups thousands, and does not follow the UI locale to do it", () => {
    expect(formatCost(1000)).toBe("$1,000.00");
    expect(formatCost(1234567.891)).toBe("$1,234,567.89");
    expect(formatCost(999.99)).toBe("$999.99");
  });

  it("collapses non-positive and non-finite amounts instead of printing $-0.5000", () => {
    expect(formatCost(-0.5)).toBe("$0");
    expect(formatCost(Number.NaN)).toBe("$0");
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("$0");
  });
});
