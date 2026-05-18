/**
 * #893 Ralph cycle 1 — canonical JSON serializer for the manifest-sha pin.
 *
 * Critical regression coverage: the previous `JSON.stringify(manifest, Object.keys(manifest).sort())`
 * replacer-array form emitted every nested object as `{}`, causing all
 * plugins' manifests to hash identically and defeating the Tier-3 pin.
 * These tests pin the contract that nested objects ARE serialized with
 * their own keys (sorted) so two plugins with different nested config
 * produce different shas.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJSON } from "../canonical-json.js";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("canonicalJSON — nested-object reorder yields identical output", () => {
  it("two manifests with reordered nested objects produce the same canonical string", () => {
    const a = {
      id: "plugin-x",
      hostSecrets: { read: ["llm.apiKey.openai"] },
      config: { foo: 1, bar: 2 },
    };
    const b = {
      config: { bar: 2, foo: 1 },
      hostSecrets: { read: ["llm.apiKey.openai"] },
      id: "plugin-x",
    };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
    expect(sha(canonicalJSON(a))).toBe(sha(canonicalJSON(b)));
  });

  it("deeply nested key reordering still produces the same canonical string", () => {
    const a = {
      a: { b: { c: 1, d: { e: 2, f: 3 } } },
    };
    const b = {
      a: { b: { d: { f: 3, e: 2 }, c: 1 } },
    };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
});

describe("canonicalJSON — nested key insertion CHANGES output (regression catch)", () => {
  it("two plugins with different nested config produce different shas (was the bug)", () => {
    // Before the fix, `JSON.stringify(m, Object.keys(m).sort())` produced
    // identical output for both inputs because nested objects collapsed
    // to `{}`. These tests pin the corrected behaviour: nested-key
    // differences must surface in the sha.
    const a = {
      id: "plugin-a",
      hostSecrets: { read: ["llm.apiKey.openai"] },
    };
    const b = {
      id: "plugin-a",
      hostSecrets: { read: ["llm.apiKey.openai", "llm.apiKey.claude"] },
    };
    expect(canonicalJSON(a)).not.toBe(canonicalJSON(b));
    expect(sha(canonicalJSON(a))).not.toBe(sha(canonicalJSON(b)));
  });

  it("adding a new top-level field changes the sha", () => {
    const a = { id: "x" };
    const b = { id: "x", extra: 1 };
    expect(canonicalJSON(a)).not.toBe(canonicalJSON(b));
  });

  it("adding a nested field changes the sha (the manifest-sha pin)", () => {
    const a = { config: { a: 1 } };
    const b = { config: { a: 1, b: 2 } };
    expect(canonicalJSON(a)).not.toBe(canonicalJSON(b));
  });
});

describe("canonicalJSON — arrays preserve order", () => {
  it("array element order matters", () => {
    const a = { tools: ["a", "b", "c"] };
    const b = { tools: ["c", "b", "a"] };
    expect(canonicalJSON(a)).not.toBe(canonicalJSON(b));
  });

  it("nested object keys inside arrays are recursively sorted", () => {
    const a = { items: [{ b: 2, a: 1 }, { d: 4, c: 3 }] };
    const b = { items: [{ a: 1, b: 2 }, { c: 3, d: 4 }] };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
});

describe("canonicalJSON — primitive round-trip", () => {
  it("null", () => {
    expect(canonicalJSON(null)).toBe("null");
  });
  it("undefined → 'null' (mirrors JSON.stringify top-level behaviour)", () => {
    expect(canonicalJSON(undefined)).toBe("null");
  });
  it("number", () => {
    expect(canonicalJSON(42)).toBe("42");
    expect(canonicalJSON(0)).toBe("0");
    expect(canonicalJSON(-1.5)).toBe("-1.5");
  });
  it("boolean", () => {
    expect(canonicalJSON(true)).toBe("true");
    expect(canonicalJSON(false)).toBe("false");
  });
  it("string", () => {
    expect(canonicalJSON("hello")).toBe('"hello"');
    expect(canonicalJSON("with \"quote\"")).toBe('"with \\"quote\\""');
  });
  it("empty object / array", () => {
    expect(canonicalJSON({})).toBe("{}");
    expect(canonicalJSON([])).toBe("[]");
  });
});

describe("canonicalJSON — Unicode stability", () => {
  it("Unicode strings round-trip identically across reorders", () => {
    const a = { name: "한글", emoji: "🚀" };
    const b = { emoji: "🚀", name: "한글" };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it("Unicode keys are sorted by code point and produce identical output", () => {
    const a = { z: 1, "한": 2, a: 3 };
    const b = { "한": 2, a: 3, z: 1 };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
});

describe("canonicalJSON — undefined property dropping", () => {
  it("an object property with undefined value is dropped", () => {
    const a = { keep: 1, drop: undefined };
    const b = { keep: 1 };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });
});

describe("canonicalJSON — regression vs the old broken serializer", () => {
  it("nested object IS emitted with its keys (old form emitted {})", () => {
    // The old code: JSON.stringify({a:0,b:{x:1},c:1},["a","b","c"]) =
    // '{"a":0,"b":{},"c":1}' — nested {x:1} collapsed to {}.
    // Pin the corrected behaviour.
    expect(canonicalJSON({ a: 0, b: { x: 1 }, c: 1 })).toBe(
      '{"a":0,"b":{"x":1},"c":1}',
    );
  });
});
