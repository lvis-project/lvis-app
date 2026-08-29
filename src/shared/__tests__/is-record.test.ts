import { describe, expect, it } from "vitest";

import { hasExactKeys, hasOnlyKeys, isRecord, isStringArray } from "../is-record.js";

describe("isRecord", () => {
  it("accepts a plain keyed object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("accepts a class instance (records read fields off Error-like objects)", () => {
    expect(isRecord(new Error("boom"))).toBe(true);
  });

  it("rejects arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("s")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe("hasExactKeys", () => {
  it("matches the key set regardless of order", () => {
    expect(hasExactKeys({ b: 1, a: 2 }, ["a", "b"])).toBe(true);
    expect(hasExactKeys({}, [])).toBe(true);
  });

  it("rejects a missing key and an extra key alike", () => {
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
  });

  it("only counts own enumerable string keys", () => {
    const withSymbol = { a: 1, [Symbol("s")]: 2 };
    expect(hasExactKeys(withSymbol, ["a"])).toBe(true);
    expect(hasExactKeys(Object.create({ inherited: 1 }), [])).toBe(true);
  });
});

describe("hasOnlyKeys", () => {
  it("accepts a subset of the allowed keys, given as an array or a set", () => {
    expect(hasOnlyKeys({ a: 1 }, ["a", "b"])).toBe(true);
    expect(hasOnlyKeys({ a: 1 }, new Set(["a", "b"]))).toBe(true);
    expect(hasOnlyKeys({}, ["a"])).toBe(true);
  });

  it("rejects any key outside the allowed set", () => {
    expect(hasOnlyKeys({ a: 1, z: 2 }, ["a", "b"])).toBe(false);
    expect(hasOnlyKeys({ z: 2 }, new Set(["a"]))).toBe(false);
  });
});

describe("isStringArray", () => {
  it("accepts arrays of strings, including the empty array", () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(["a", ""])).toBe(true);
  });

  it("rejects non-arrays and arrays with a non-string element", () => {
    expect(isStringArray("a")).toBe(false);
    expect(isStringArray(["a", 1])).toBe(false);
    expect(isStringArray([undefined])).toBe(false);
    expect(isStringArray(null)).toBe(false);
  });
});
