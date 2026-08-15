/**
 * Pins the spawn/resume payload parity property this transform exists for.
 *
 * A fresh spawn sends the builtin surface; a resume forces the whole FROZEN
 * tool scope (every plugin/MCP tool recorded at spawn) back into the request.
 * That asymmetry is why a `pattern` shorthand living in one plugin schema takes
 * down resumes only. These tests assert the two payloads agree on the field
 * that broke — every `pattern` reaching the wire is grammar-translatable —
 * and that the expansion is an identity on the regex language.
 */
import { describe, it, expect } from "vitest";
import {
  expandRegexShorthandClasses,
  toGrammarSafeToolSchemas,
} from "../grammar-safe-tool-schema.js";
import type { ToolSchema } from "../types.js";

/** The shorthands whose verbatim emission breaks a GBNF/xgrammar compiler. */
const GRAMMAR_HOSTILE_ESCAPE_RE = /\\[dDwWsS]/;

function collectPatterns(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) collectPatterns(entry, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "pattern" && typeof value === "string") out.push(value);
    else collectPatterns(value, out);
  }
  return out;
}

function objectSchema(properties: Record<string, unknown>): ToolSchema["inputSchema"] {
  return { type: "object", properties };
}

describe("expandRegexShorthandClasses", () => {
  it("expands every positive shorthand to its class", () => {
    expect(expandRegexShorthandClasses("^\\d$")).toBe("^[0-9]$");
    expect(expandRegexShorthandClasses("^\\w$")).toBe("^[0-9A-Z_a-z]$");
    expect(expandRegexShorthandClasses("^\\s$")).toContain("\\t\\n");
  });

  it("expands negated shorthands to complement classes", () => {
    expect(expandRegexShorthandClasses("^\\D+$")).toBe("^[^0-9]+$");
    expect(expandRegexShorthandClasses("^\\W$")).toBe("^[^0-9A-Z_a-z]$");
  });

  it("splices class bodies (not nested brackets) inside a character class", () => {
    expect(expandRegexShorthandClasses("^[\\d-]$")).toBe("^[0-9-]$");
    expect(expandRegexShorthandClasses("^[a\\w]$")).toBe("^[a0-9A-Z_a-z]$");
  });

  it("leaves a negated shorthand inside a class alone rather than inverting it", () => {
    // A complement cannot be spliced into a member list; rewriting it to the
    // positive body would match the exact opposite set.
    expect(expandRegexShorthandClasses("^[\\D]$")).toBe("^[\\D]$");
  });

  it("returns the same string when there is nothing to expand", () => {
    const pattern = "^[0-9]{4}-[0-9]{2}$";
    expect(expandRegexShorthandClasses(pattern)).toBe(pattern);
    expect(expandRegexShorthandClasses("^a\\.b$")).toBe("^a\\.b$");
  });

  it("does not treat an escaped bracket as a class delimiter", () => {
    // `\[` must not open a class, or the following `\d` would be spliced
    // as a bare body and silently change meaning.
    expect(expandRegexShorthandClasses("^\\[\\d$")).toBe("^\\[[0-9]$");
  });

  it("preserves match behaviour on the real plugin patterns that broke", () => {
    const cases: Array<[string, string[]]> = [
      ["^(?:\\d{4}-\\d{2}-\\d{2}|\\d{8})$", ["2026-08-15", "20260815", "2026-8-15", "x", ""]],
      ["^(?:[가-힣]{2})?\\d{2,3}[가-힣]\\d{4}$", ["12가1234", "123가1234", "서울12가1234", "ab1234"]],
      ["^\\w+\\s\\d$", ["ab 1", "ab  1", "a 1", "a\t2"]],
      ["^[\\d\\s]+$", ["12 3", "12 ", "12a"]],
    ];
    for (const [pattern, samples] of cases) {
      const expanded = expandRegexShorthandClasses(pattern);
      expect(expanded).not.toMatch(GRAMMAR_HOSTILE_ESCAPE_RE);
      for (const sample of samples) {
        expect(new RegExp(expanded).test(sample)).toBe(new RegExp(pattern).test(sample));
      }
    }
  });
});

describe("toGrammarSafeToolSchemas", () => {
  it("passes through undefined and empty lists untouched", () => {
    expect(toGrammarSafeToolSchemas(undefined)).toBeUndefined();
    const empty: ToolSchema[] = [];
    expect(toGrammarSafeToolSchemas(empty)).toBe(empty);
  });

  it("returns the SAME reference when no pattern needs rewriting", () => {
    const schemas: ToolSchema[] = [
      { name: "read_file", description: "d", inputSchema: objectSchema({ path: { type: "string" } }) },
    ];
    expect(toGrammarSafeToolSchemas(schemas)).toBe(schemas);
  });

  it("rewrites patterns nested under array items", () => {
    // The exact shape of ep_parking_read/ep_parking_write, which is what the
    // grammar compiler refused.
    const schemas: ToolSchema[] = [
      {
        name: "ep_parking_read",
        description: "d",
        inputSchema: objectSchema({
          dates: {
            type: "array",
            items: { type: "string", pattern: "^(?:\\d{4}-\\d{2}-\\d{2}|\\d{8})$" },
          },
        }),
      },
    ];
    const out = toGrammarSafeToolSchemas(schemas)!;
    expect(out).not.toBe(schemas);
    expect(collectPatterns(out[0]!.inputSchema)).toEqual([
      "^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{8})$",
    ]);
    // The input schema is not mutated in place.
    expect(collectPatterns(schemas[0]!.inputSchema)[0]).toContain("\\d");
  });

  it("rewrites patterns under allOf/if/then branches and keeps untouched tools by reference", () => {
    const clean: ToolSchema = {
      name: "index_search",
      description: "d",
      inputSchema: objectSchema({ query: { type: "string" } }),
    };
    const dirty: ToolSchema = {
      name: "ep_attendance_read",
      description: "d",
      inputSchema: {
        type: "object",
        properties: { operation: { type: "string" } },
        allOf: [
          { if: { properties: { operation: { const: "calendar" } } },
            then: { properties: { date: { type: "string", pattern: "^\\d{8}$" } } } },
        ],
      } as ToolSchema["inputSchema"],
    };
    const out = toGrammarSafeToolSchemas([clean, dirty])!;
    expect(out[0]).toBe(clean);
    expect(collectPatterns(out[1]!.inputSchema)).toEqual(["^[0-9]{8}$"]);
  });

  it("leaves no grammar-hostile escape in a resume-shaped (full frozen scope) payload", () => {
    // Spawn sends builtins; resume forces the whole persisted scope back in.
    // Both must satisfy the same wire invariant.
    const spawnSurface: ToolSchema[] = [
      { name: "read_file", description: "d", inputSchema: objectSchema({ path: { type: "string" } }) },
    ];
    const resumeSurface: ToolSchema[] = [
      ...spawnSurface,
      {
        name: "ep_parking_write",
        description: "d",
        inputSchema: objectSchema({
          dates: { type: "array", items: { type: "string", pattern: "^(?:\\d{4}-\\d{2}-\\d{2}|\\d{8})$" } },
          carNumber: { type: "string", pattern: "^(?:[가-힣]{2})?\\d{2,3}[가-힣]\\d{4}$" },
        }),
      },
    ];
    for (const surface of [spawnSurface, resumeSurface]) {
      const serialized = JSON.stringify(toGrammarSafeToolSchemas(surface));
      expect(serialized).not.toMatch(GRAMMAR_HOSTILE_ESCAPE_RE);
    }
  });
});
