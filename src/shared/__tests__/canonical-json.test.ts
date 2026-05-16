/**
 * Unit tests for canonicalStringify (H-1 undefined asymmetry fix, R-5).
 *
 * Verifies that canonicalStringify behaves identically to JSON.stringify for
 * all cases that JSON.stringify handles, and correctly serialises undefined
 * top-level values as "null" (RFC 8259).
 *
 * Issue: #691 PR-A4 Round 5
 */
import { describe, it, expect } from "vitest";
import { canonicalStringify } from "../canonical-json.js";

describe("canonicalStringify", () => {
  it("drops keys whose value is undefined — matches JSON.stringify", () => {
    const input = { a: undefined, b: 1 };
    expect(canonicalStringify(input)).toBe('{"b":1}');
    expect(canonicalStringify(input)).toBe(JSON.stringify(input));
  });

  it("sorts keys deterministically regardless of insertion order", () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("serialises top-level undefined as null (RFC 8259 — no undefined token)", () => {
    expect(canonicalStringify(undefined)).toBe("null");
  });

  it("serialises null as null", () => {
    expect(canonicalStringify(null)).toBe("null");
  });

  it("serialises primitives identically to JSON.stringify", () => {
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify("hello")).toBe('"hello"');
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(false)).toBe("false");
  });

  it("serialises arrays identically to JSON.stringify (no key sorting)", () => {
    const arr = [3, 1, 2];
    expect(canonicalStringify(arr)).toBe(JSON.stringify(arr));
  });

  it("handles nested objects with undefined values", () => {
    const input = { a: { x: undefined, y: 2 }, b: 1 };
    expect(canonicalStringify(input)).toBe('{"a":{"y":2},"b":1}');
  });

  it("produces same result as JSON.stringify for objects with no undefined values", () => {
    const obj = { z: 3, a: 1, m: 2 };
    // JSON.stringify preserves insertion order; canonicalStringify sorts keys
    // so equality only holds when there are no undefined values AND keys are sorted.
    const sorted = Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
    expect(canonicalStringify(obj)).toBe(JSON.stringify(sorted));
  });

  // Issue #797 — defense-in-depth: cycle guard + depth cap
  describe("cycle guard + depth cap (#797)", () => {
    it("does not stack-overflow on a self-referencing object", () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;
      expect(() => canonicalStringify(obj)).not.toThrow();
      expect(canonicalStringify(obj)).toContain('"[Circular]"');
    });

    it("does not stack-overflow on a mutual cycle (a → b → a)", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b", a };
      a.b = b;
      expect(() => canonicalStringify(a)).not.toThrow();
      expect(canonicalStringify(a)).toContain('"[Circular]"');
    });

    it("caps deeply nested objects with [MaxDepth] marker", () => {
      let leaf: Record<string, unknown> = { v: 1 };
      for (let i = 0; i < 200; i++) {
        leaf = { nested: leaf };
      }
      expect(() => canonicalStringify(leaf)).not.toThrow();
      expect(canonicalStringify(leaf)).toContain('"[MaxDepth]"');
    });

    it("sibling objects sharing structure across separate calls each serialize cleanly", () => {
      // Each top-level call starts with a fresh WeakSet, so a shared
      // subgraph referenced from two distinct root objects does NOT
      // count as a cycle from either root's perspective.
      const shared = { x: 1 };
      const a = { shared };
      const b = { shared };
      expect(canonicalStringify(a)).toBe(canonicalStringify(b));
      expect(canonicalStringify(a)).not.toContain('"[Circular]"');
    });
  });
});
