import { describe, expect, it } from "vitest";

import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  requirePositiveInteger,
} from "../safe-integer.js";

describe("isPositiveSafeInteger", () => {
  it("accepts safe integers above zero only", () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(-1)).toBe(false);
    expect(isPositiveSafeInteger(1.5)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isPositiveSafeInteger("1")).toBe(false);
    expect(isPositiveSafeInteger(NaN)).toBe(false);
  });
});

describe("isNonNegativeSafeInteger", () => {
  it("accepts zero and safe integers above it", () => {
    expect(isNonNegativeSafeInteger(0)).toBe(true);
    expect(isNonNegativeSafeInteger(7)).toBe(true);
    expect(isNonNegativeSafeInteger(-0)).toBe(true);
    expect(isNonNegativeSafeInteger(-1)).toBe(false);
    expect(isNonNegativeSafeInteger(Infinity)).toBe(false);
    expect(isNonNegativeSafeInteger(null)).toBe(false);
  });
});

describe("requirePositiveInteger", () => {
  it("returns the value when it is a positive safe integer", () => {
    expect(requirePositiveInteger(3, "unused")).toBe(3);
  });

  it("throws a RangeError carrying exactly the caller's message", () => {
    expect(() => requirePositiveInteger(0, "platform-bridge-delivery-maxTextChars-invalid"))
      .toThrowError(new RangeError("platform-bridge-delivery-maxTextChars-invalid"));
    expect(() => requirePositiveInteger(undefined, "limit must be a positive safe integer."))
      .toThrowError(RangeError);
  });
});
