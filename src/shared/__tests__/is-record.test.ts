import { describe, expect, it } from "vitest";
import { hasExactKeys, hasOnlyKeys, isPlainRecord, isRecord, isStringArray } from "../is-record.js";

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

describe("isPlainRecord", () => {
  it("accepts what JSON.parse produces and a null-prototype object", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord(JSON.parse('{"a":1}'))).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
  });

  it("refuses a class instance that the loose guard accepts", () => {
    expect(isRecord(new Error("boom"))).toBe(true);
    expect(isPlainRecord(new Error("boom"))).toBe(false);
    expect(isPlainRecord(new (class Payload {})())).toBe(false);
    expect(isPlainRecord(Object.create({ inherited: true }))).toBe(false);
  });

  it("refuses arrays, null and non-objects like the loose guard", () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord("s")).toBe(false);
    expect(isPlainRecord(1)).toBe(false);
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

  it("refuses a sparse array: a hole would surface as undefined in a string[]", () => {
    const sparse = new Array<string>(1);
    expect(isStringArray(sparse)).toBe(false);
    const holeInTheMiddle: string[] = [];
    holeInTheMiddle[0] = "a";
    holeInTheMiddle[2] = "c";
    expect(isStringArray(holeInTheMiddle)).toBe(false);
  });
});
