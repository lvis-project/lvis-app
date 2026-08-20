import { describe, expect, it } from "vitest";

import { isRecord } from "../is-record.js";

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
