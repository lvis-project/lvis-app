import { describe, it, expect } from "vitest";
import { lintToolInputSchema } from "../tool-schema-lint.js";

describe("lintToolInputSchema — array-missing-items (#1182)", () => {
  it("passes a valid object schema with scalar properties", () => {
    expect(
      lintToolInputSchema({
        type: "object",
        properties: { path: { type: "string" }, count: { type: "number" } },
      }),
    ).toEqual([]);
  });

  it("passes an array property that declares items", () => {
    expect(
      lintToolInputSchema({
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
      }),
    ).toEqual([]);
  });

  it("flags a plain array property without items (with JSON pointer)", () => {
    const v = lintToolInputSchema({
      type: "object",
      properties: { tags: { type: "array" } },
    });
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe("array-missing-items");
    expect(v[0].pointer).toBe("/properties/tags");
  });

  it("flags a union type that includes array without items (the meeting v0.5.21 incident)", () => {
    const v = lintToolInputSchema({
      type: "object",
      properties: {
        meetingAgenda: { type: ["string", "array"] },
        todayAgenda: { type: ["string", "array"] },
      },
    });
    expect(v.map((x) => x.pointer).sort()).toEqual([
      "/properties/meetingAgenda",
      "/properties/todayAgenda",
    ]);
    expect(v.every((x) => x.rule === "array-missing-items")).toBe(true);
  });

  it("passes a union type that includes array WITH items", () => {
    expect(
      lintToolInputSchema({
        type: "object",
        properties: { agenda: { type: ["string", "array"], items: { type: "string" } } },
      }),
    ).toEqual([]);
  });

  it("recurses into nested array items, combinators, and additionalProperties", () => {
    const v = lintToolInputSchema({
      type: "object",
      properties: {
        nested: { type: "array", items: { type: "object", properties: { bad: { type: "array" } } } },
        union: { anyOf: [{ type: "string" }, { type: "array" }] },
      },
      additionalProperties: { type: "array" },
    });
    const pointers = v.map((x) => x.pointer).sort();
    expect(pointers).toEqual([
      "/additionalProperties",
      "/properties/nested/items/properties/bad",
      "/properties/union/anyOf/1",
    ]);
  });

  it("escapes JSON-pointer special characters in property names", () => {
    const v = lintToolInputSchema({
      type: "object",
      properties: { "a/b~c": { type: "array" } },
    });
    expect(v[0].pointer).toBe("/properties/a~1b~0c");
  });

  it("is total — never throws on non-schema / malformed input", () => {
    expect(lintToolInputSchema(undefined)).toEqual([]);
    expect(lintToolInputSchema(null)).toEqual([]);
    expect(lintToolInputSchema("nope")).toEqual([]);
    expect(lintToolInputSchema([{ type: "array" }])).toEqual([]);
  });
});
