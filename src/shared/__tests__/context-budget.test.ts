import { describe, it, expect } from "vitest";
import { getUsableContext, getPreflightThreshold } from "../context-budget.js";

describe("getUsableContext — Cline tier-fixed buffers", () => {
  it("64K → 37K usable (27K reserved for output-heavy small models)", () => {
    expect(getUsableContext(64_000)).toBe(37_000);
  });

  it("128K → 98K usable (30K reserved)", () => {
    expect(getUsableContext(128_000)).toBe(98_000);
  });

  it("200K → 160K usable (40K reserved — Anthropic default tier)", () => {
    expect(getUsableContext(200_000)).toBe(160_000);
  });

  it("1M → 960K usable (40K floor wins over 0.8× = 800K)", () => {
    expect(getUsableContext(1_000_000)).toBe(960_000);
  });

  it("2M → 1.96M usable", () => {
    expect(getUsableContext(2_000_000)).toBe(1_960_000);
  });

  it("medium 1.05M (gpt-5.4) → 1.01M usable", () => {
    expect(getUsableContext(1_050_000)).toBe(1_010_000);
  });

  it("tiny window 32K → 25.6K (0.8× wins, avoids negative)", () => {
    expect(getUsableContext(32_000)).toBe(25_600);
  });

  it("threshold edge: 40K → 32K (0.8× exactly)", () => {
    expect(getUsableContext(40_000)).toBe(32_000);
  });

  it("invalid inputs return 0", () => {
    expect(getUsableContext(0)).toBe(0);
    expect(getUsableContext(-100)).toBe(0);
    expect(getUsableContext(NaN)).toBe(0);
    expect(getUsableContext(Infinity)).toBe(0);
  });

  it("usable is always strictly less than raw for positive ctx", () => {
    for (const ctx of [16_000, 64_000, 128_000, 200_000, 400_000, 1_000_000]) {
      expect(getUsableContext(ctx)).toBeLessThan(ctx);
      expect(getUsableContext(ctx)).toBeGreaterThan(0);
    }
  });
});

describe("getPreflightThreshold — Layer 0 trigger (v3 §6 LVIS conservative default)", () => {
  it("64K → floor(37K × 50%) = 18,500", () => {
    // usable = 37,000, pct = 0.50
    expect(getPreflightThreshold(64_000)).toBe(18_500);
  });

  it("128K → floor(98K × 55%) = 53,900", () => {
    // usable = 98,000, pct = 0.55
    expect(getPreflightThreshold(128_000)).toBe(53_900);
  });

  it("200K → floor(160K × 60%) = 96,000", () => {
    // usable = 160,000, pct = 0.60 (Anthropic default tier)
    expect(getPreflightThreshold(200_000)).toBe(96_000);
  });

  it("1M → floor(960K × 65%) = 624,000", () => {
    // usable = 960,000, pct = 0.65 (1M beta)
    expect(getPreflightThreshold(1_000_000)).toBe(624_000);
  });

  it("Other (>1M) → 60% bucket", () => {
    // 2M → usable 1,960,000, pct = 0.60 → floor = 1,176,000
    expect(getPreflightThreshold(2_000_000)).toBe(1_176_000);
  });

  it("Boundary <=64K (e.g. 32K small) → 50% bucket", () => {
    // 32K → usable 25,600, pct = 0.50 → 12,800
    expect(getPreflightThreshold(32_000)).toBe(12_800);
  });

  it("invalid inputs return 0", () => {
    expect(getPreflightThreshold(0)).toBe(0);
    expect(getPreflightThreshold(-100)).toBe(0);
    expect(getPreflightThreshold(NaN)).toBe(0);
    expect(getPreflightThreshold(Infinity)).toBe(0);
  });

  it("threshold is always less than usable for positive ctx", () => {
    for (const ctx of [64_000, 128_000, 200_000, 1_000_000, 2_000_000]) {
      expect(getPreflightThreshold(ctx)).toBeLessThan(getUsableContext(ctx));
      expect(getPreflightThreshold(ctx)).toBeGreaterThan(0);
    }
  });

  it("threshold percentage is conservative (≤65% of usable)", () => {
    for (const ctx of [64_000, 128_000, 200_000, 1_000_000, 2_000_000]) {
      const ratio = getPreflightThreshold(ctx) / getUsableContext(ctx);
      expect(ratio).toBeLessThanOrEqual(0.65);
      expect(ratio).toBeGreaterThanOrEqual(0.50);
    }
  });
});
