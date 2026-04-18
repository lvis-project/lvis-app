import { describe, it, expect } from "vitest";
import { costTier, estimateTokens, estimateTurnCost, formatCostBadge } from "../cost-estimator.js";

describe("cost-estimator", () => {
  it("estimateTokens matches the engine heuristic (ceil/4 + 1)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("abcde")).toBe(3);
  });

  it("estimateTurnCost sums history + draft against the pricing table", () => {
    const out = estimateTurnCost({
      historySerialized: ["{\"role\":\"user\",\"content\":\"hi\"}"],
      draft: "hello world",
      maxOutputTokens: 1000,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    });
    expect(out.inputTokens).toBeGreaterThan(0);
    expect(out.outputTokens).toBe(1000);
    expect(out.outputCost).toBeCloseTo((1000 / 1_000_000) * 15);
    expect(out.total).toBeCloseTo(out.inputCost + out.outputCost);
  });

  it("zero draft yields only history input cost", () => {
    const out = estimateTurnCost({
      historySerialized: [],
      draft: "",
      maxOutputTokens: 0,
      pricing: { inputPer1M: 3, outputPer1M: 15 },
    });
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.total).toBe(0);
  });

  it("costTier bucketing matches the spec thresholds", () => {
    expect(costTier(0.001)).toBe("trivial");
    expect(costTier(0.05)).toBe("low");
    expect(costTier(0.5)).toBe("medium");
    expect(costTier(2)).toBe("high");
  });

  it("formatCostBadge renders reasonable strings", () => {
    expect(formatCostBadge(0.001)).toMatch(/^~\$/);
    expect(formatCostBadge(0.05)).toBe("~$0.05");
    expect(formatCostBadge(1.5)).toBe("~$1.50");
  });
});
