import { describe, expect, it } from "vitest";

import { isPlainRecord, isRecord } from "../is-record.js";

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
