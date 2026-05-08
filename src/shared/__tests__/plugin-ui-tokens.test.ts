import { describe, it, expect } from "vitest";
import { isLvisThemeBundleId, LVIS_THEME_BUNDLE_IDS } from "../plugin-ui-tokens.js";

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
