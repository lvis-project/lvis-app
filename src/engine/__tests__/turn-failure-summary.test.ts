import { describe, expect, it } from "vitest";
import {
  deriveTurnFailureSummary,
  MAX_TURN_FAILURE_SUMMARY_CHARS,
  toSafeTurnFailureSummary,
  TURN_FAILURE_CATEGORIES,
  type TurnFailureCategory,
} from "../turn-failure-summary.js";

describe("turn failure summary", () => {
  it("maps the provider error classification onto the closed category union", () => {
    const cases: readonly [string, TurnFailureCategory][] = [
      ["api-key", "auth"],
      ["rate-limit", "rate-limit"],
      ["context-length", "context"],
      ["network", "network"],
      ["model", "model"],
      ["unknown", "provider"],
    ];
    for (const [classifierCategory, expected] of cases) {
      const summary = deriveTurnFailureSummary({
        systemNotice: "stream-error",
        classifierCategory,
      });
      expect(summary.category).toBe(expected);
      expect(summary.summary.length).toBeGreaterThan(0);
      expect(summary.summary.length).toBeLessThanOrEqual(MAX_TURN_FAILURE_SUMMARY_CHARS);
    }
  });

  it("falls back to the system notice and never widens the union for a drifting classification", () => {
    expect(deriveTurnFailureSummary({ systemNotice: "context-error" }).category).toBe("context");
    expect(deriveTurnFailureSummary({ systemNotice: "stream-error" }).category).toBe("provider");
    expect(deriveTurnFailureSummary({}).category).toBe("internal");

    const forged = deriveTurnFailureSummary({
      systemNotice: "stream-error",
      classifierCategory: "sk-FAKE-TOKEN-1234567890",
    });
    expect(TURN_FAILURE_CATEGORIES).toContain(forged.category);
    expect(forged.summary).not.toContain("sk-FAKE-TOKEN-1234567890");
  });

  it("emits exactly the two whitelisted fields with fixed table text", () => {
    const summary = deriveTurnFailureSummary({ systemNotice: "stream-error" });
    expect(Object.keys(summary).sort()).toEqual(["category", "summary"]);
    expect(summary).toEqual({
      category: "provider",
      summary: "The model provider returned an error.",
    });
  });

  it("re-admits only whitelisted, bounded fields and fails closed otherwise", () => {
    const produced = deriveTurnFailureSummary({ classifierCategory: "rate-limit" });
    expect(toSafeTurnFailureSummary(produced)).toEqual(produced);

    // A forged summary crossing the boundary keeps only the two whitelisted
    // fields, truncated: the embedded token-like tail cannot flow verbatim.
    const forged = toSafeTurnFailureSummary({
      category: "provider",
      summary: `provider said ${"x".repeat(300)} token sk-FAKE-TOKEN-1234567890 end`,
      stack: "at C:\\private\\secret.ts:1",
      token: "sk-FAKE-TOKEN-1234567890",
    });
    expect(forged).toBeDefined();
    expect(Object.keys(forged!).sort()).toEqual(["category", "summary"]);
    expect(forged!.summary.length).toBeLessThanOrEqual(MAX_TURN_FAILURE_SUMMARY_CHARS);
    expect(JSON.stringify(forged)).not.toContain("secret.ts");
    expect(JSON.stringify(forged)).not.toContain("sk-FAKE-TOKEN-1234567890");

    // Control characters are stripped rather than delivered to a provider.
    expect(toSafeTurnFailureSummary({ category: "network", summary: "a\u0000b\u001f\u007fc" }))
      .toEqual({ category: "network", summary: "abc" });

    // Fail closed: unknown category, wrong shapes, or empty sanitized text.
    expect(toSafeTurnFailureSummary({ category: "stack-trace", summary: "x" })).toBeUndefined();
    expect(toSafeTurnFailureSummary({ category: "provider", summary: 5 })).toBeUndefined();
    expect(toSafeTurnFailureSummary({ category: "provider", summary: "\u0000\u0001" })).toBeUndefined();
    expect(toSafeTurnFailureSummary("provider")).toBeUndefined();
    expect(toSafeTurnFailureSummary(undefined)).toBeUndefined();
    expect(toSafeTurnFailureSummary(null)).toBeUndefined();
  });
});
