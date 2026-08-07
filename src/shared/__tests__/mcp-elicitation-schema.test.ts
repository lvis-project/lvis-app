/**
 * The single authority for elicitation-schema support. Both the approval dialog
 * and the main-process resolver consume this parser; anything it accepts must be
 * renderable, and anything it rejects must be refused end to end.
 */
import { describe, expect, it } from "vitest";
import { parseElicitationSchema } from "../mcp-elicitation-schema.js";

function objectSchema(properties: Record<string, unknown>, required?: unknown): unknown {
  return { type: "object", properties, ...(required !== undefined ? { required } : {}) };
}

describe("parseElicitationSchema", () => {
  it("accepts an enum whose members include the empty string", () => {
    const parsed = parseElicitationSchema(
      objectSchema({ priority: { type: "string", enum: ["", "high"] } }, ["priority"]),
    );

    expect(parsed?.fields).toEqual([
      { name: "priority", kind: "string", required: true, enumValues: ["", "high"] },
    ]);
  });

  it("defaults an enum-only property to the string kind", () => {
    const parsed = parseElicitationSchema(objectSchema({ tone: { enum: ["warm", "curt"] } }));

    expect(parsed?.fields).toEqual([
      { name: "tone", kind: "string", required: false, enumValues: ["warm", "curt"] },
    ]);
  });

  it("carries title, description and default through for display", () => {
    const parsed = parseElicitationSchema(
      objectSchema({
        date: { type: "string", title: "  Date  ", description: " When ", default: "2026-07-01" },
      }),
    );

    expect(parsed?.fields).toEqual([
      {
        name: "date",
        kind: "string",
        required: false,
        title: "Date",
        description: "When",
        defaultValue: "2026-07-01",
      },
    ]);
  });

  it("omits blank title and description rather than showing whitespace", () => {
    const parsed = parseElicitationSchema(
      objectSchema({ date: { type: "string", title: "   ", description: 7 } }),
    );

    expect(parsed?.fields).toEqual([{ name: "date", kind: "string", required: false }]);
  });

  it("rejects the whole schema when any enum member is not a JSON scalar", () => {
    expect(parseElicitationSchema(objectSchema({ tag: { enum: ["a", { nested: 1 }] } }))).toBeUndefined();
    expect(parseElicitationSchema(objectSchema({ tag: { enum: ["a", ["b"]] } }))).toBeUndefined();
  });

  it("rejects the whole schema when an enum member is a non-finite number", () => {
    expect(parseElicitationSchema(objectSchema({ n: { enum: [1, Number.NaN] } }))).toBeUndefined();
    expect(
      parseElicitationSchema(objectSchema({ n: { enum: [1, Number.POSITIVE_INFINITY] } })),
    ).toBeUndefined();
  });

  it("rejects an empty enum, a non-array enum and an unsupported type", () => {
    expect(parseElicitationSchema(objectSchema({ tag: { enum: [] } }))).toBeUndefined();
    expect(parseElicitationSchema(objectSchema({ tag: { enum: "high" } }))).toBeUndefined();
    expect(parseElicitationSchema(objectSchema({ tags: { type: "array" } }))).toBeUndefined();
  });

  it("rejects a property that declares neither type nor enum", () => {
    expect(parseElicitationSchema(objectSchema({ mystery: { title: "?" } }))).toBeUndefined();
  });

  it("rejects a required name with no matching property", () => {
    expect(
      parseElicitationSchema(objectSchema({ date: { type: "string" } }, ["date", "ghost"])),
    ).toBeUndefined();
  });

  it("rejects a non-string-array required list", () => {
    expect(parseElicitationSchema(objectSchema({ date: { type: "string" } }, [7]))).toBeUndefined();
    expect(parseElicitationSchema(objectSchema({ date: { type: "string" } }, "date"))).toBeUndefined();
  });

  it("rejects unsafe field names", () => {
    expect(parseElicitationSchema(objectSchema({ "bad name": { type: "string" } }))).toBeUndefined();
    expect(parseElicitationSchema(objectSchema({ "9lives": { type: "string" } }))).toBeUndefined();
  });

  it("accepts twelve fields and rejects thirteen", () => {
    const build = (count: number): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: count }, (_unused, index) => [`f${index}`, { type: "string" }]),
      );

    expect(parseElicitationSchema(objectSchema(build(12)))?.fields).toHaveLength(12);
    expect(parseElicitationSchema(objectSchema(build(13)))).toBeUndefined();
  });

  it("rejects non-object schema envelopes", () => {
    expect(parseElicitationSchema(undefined)).toBeUndefined();
    expect(parseElicitationSchema({ type: "string", properties: {} })).toBeUndefined();
    expect(parseElicitationSchema({ type: "object" })).toBeUndefined();
    expect(parseElicitationSchema([{ type: "object", properties: {} }])).toBeUndefined();
  });
});
