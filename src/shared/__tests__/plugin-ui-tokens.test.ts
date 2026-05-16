import { describe, it, expect } from "vitest";
import { isLvisThemeBundleId, LVIS_THEME_BUNDLE_IDS, LVIS_TOKEN_NAMES } from "../plugin-ui-tokens.js";

const DERIVED_TOKENS = [
  "--lvis-primary-bg-subtle",
  "--lvis-primary-bg-strong",
  "--lvis-danger-bg-subtle",
  "--lvis-warning-bg-subtle",
  "--lvis-success-bg-subtle",
  "--lvis-surface-hover",
  "--lvis-focus-shadow",
] as const;

describe("LVIS_TOKEN_NAMES — derived tinted-surface tokens", () => {
  it("includes all 7 new derived tokens", () => {
    for (const token of DERIVED_TOKENS) {
      expect(LVIS_TOKEN_NAMES).toContain(token);
    }
  });

  it("has no duplicate token names", () => {
    const seen = new Set<string>();
    for (const name of LVIS_TOKEN_NAMES) {
      expect(seen.has(name), `duplicate token: ${name}`).toBe(false);
      seen.add(name);
    }
  });
});

describe("isLvisThemeBundleId", () => {
  it("accepts every member of LVIS_THEME_BUNDLE_IDS", () => {
    for (const id of LVIS_THEME_BUNDLE_IDS) {
      expect(isLvisThemeBundleId(id)).toBe(true);
    }
  });

  it("rejects non-member strings", () => {
    expect(isLvisThemeBundleId("non-existent-bundle")).toBe(false);
    expect(isLvisThemeBundleId("")).toBe(false);
  });

  it("rejects non-strings (boundary safety)", () => {
    expect(isLvisThemeBundleId(null)).toBe(false);
    expect(isLvisThemeBundleId(undefined)).toBe(false);
    expect(isLvisThemeBundleId(42)).toBe(false);
    expect(isLvisThemeBundleId({})).toBe(false);
    expect(isLvisThemeBundleId([])).toBe(false);
  });
});
