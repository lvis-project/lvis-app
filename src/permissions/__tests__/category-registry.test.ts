/**
 * Q12 Layer 3 — Category Registry coverage.
 *
 * Pins the contract:
 *   - registerStandardCategories() populates exactly 5 axes
 *   - lookup throws on unknown categories
 *   - listKnownCategories() reports the populated set
 *   - decisionFor() returns the design's matrix lanes
 *
 * Phase 3 risk classifier will read riskWeight here; pin those numbers
 * so a future weight bump is a deliberate decision.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  clearCategoryRegistry,
  getToolCategoryDescriptor,
  listKnownCategories,
  registerStandardCategories,
  registerToolCategory,
} from "../category-registry.js";
import type { ToolCategory } from "../../tools/types.js";

// Restore the standard set at file teardown so other tests in the same
// vitest worker (which cache module state) don't observe an empty
// registry left over by the lookup-errors describe block.
afterAll(() => {
  clearCategoryRegistry();
  registerStandardCategories();
});

describe("Category Registry — registerStandardCategories", () => {
  beforeEach(() => {
    clearCategoryRegistry();
    registerStandardCategories();
  });

  it("populates all 5 standard axes", () => {
    const known = listKnownCategories().sort();
    expect(known).toEqual(["meta", "network", "read", "shell", "write"].sort());
  });

  it("read descriptor allows in default/auto, asks in strict", () => {
    const d = getToolCategoryDescriptor("read");
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: false })).toBe("allow");
    expect(d.decisionFor({ mode: "auto", source: "builtin", headless: false })).toBe("allow");
    expect(d.decisionFor({ mode: "strict", source: "builtin", headless: false })).toBe("ask");
  });

  it("write descriptor asks in default/strict, allows in auto, defers to reviewer when headless", () => {
    const d = getToolCategoryDescriptor("write");
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: false })).toBe("ask");
    expect(d.decisionFor({ mode: "auto", source: "builtin", headless: false })).toBe("allow");
    expect(d.decisionFor({ mode: "strict", source: "builtin", headless: false })).toBe("ask");
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: true })).toBe("reviewer");
  });

  it("shell descriptor asks in every interactive mode and routes headless to reviewer", () => {
    const d = getToolCategoryDescriptor("shell");
    for (const mode of ["default", "auto", "strict"] as const) {
      expect(d.decisionFor({ mode, source: "builtin", headless: false })).toBe("ask");
    }
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: true })).toBe("reviewer");
  });

  it("network descriptor matches write's auto-allow lane", () => {
    const d = getToolCategoryDescriptor("network");
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: false })).toBe("ask");
    expect(d.decisionFor({ mode: "auto", source: "builtin", headless: false })).toBe("allow");
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: true })).toBe("reviewer");
  });

  it("meta descriptor returns the override sentinel — executor reads decisionOverride", () => {
    const d = getToolCategoryDescriptor("meta");
    expect(d.decisionFor({ mode: "default", source: "builtin", headless: false })).toBe("override");
    expect(d.decisionFor({ mode: "auto", source: "plugin", headless: true })).toBe("override");
  });

  it("riskWeight ordering matches Phase 3 classifier expectation: shell > network > write > read > meta", () => {
    const w = (c: ToolCategory) => getToolCategoryDescriptor(c).riskWeight;
    expect(w("shell")).toBeGreaterThan(w("network"));
    expect(w("network")).toBeGreaterThan(w("write"));
    expect(w("write")).toBeGreaterThan(w("read"));
    expect(w("read")).toBeGreaterThan(w("meta"));
  });
});

describe("Category Registry — lookup errors", () => {
  beforeEach(() => {
    clearCategoryRegistry();
  });

  it("throws when accessing an unregistered category — fail closed", () => {
    expect(() => getToolCategoryDescriptor("read")).toThrow(
      /Unknown tool category 'read'/,
    );
  });

  it("listKnownCategories is empty before registration", () => {
    expect(listKnownCategories()).toEqual([]);
  });

  it("supports custom registration (Open-Closed)", () => {
    registerToolCategory({
      name: "read",
      riskWeight: 0.05,
      decisionFor: () => "allow",
    });
    const d = getToolCategoryDescriptor("read");
    expect(d.riskWeight).toBe(0.05);
    expect(listKnownCategories()).toEqual(["read"]);
  });

  it("re-registering the same category overwrites the previous descriptor", () => {
    registerToolCategory({
      name: "read",
      riskWeight: 0.1,
      decisionFor: () => "allow",
    });
    registerToolCategory({
      name: "read",
      riskWeight: 0.3,
      decisionFor: () => "ask",
    });
    expect(getToolCategoryDescriptor("read").riskWeight).toBe(0.3);
    expect(getToolCategoryDescriptor("read").decisionFor({
      mode: "default",
      source: "builtin",
      headless: false,
    })).toBe("ask");
  });
});
