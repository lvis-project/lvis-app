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

const CHAT_SEMANTIC_TOKENS = [
  "--lvis-message-user-bg",
  "--lvis-message-user-fg",
  "--lvis-message-user-border",
  "--lvis-message-user-muted",
  "--lvis-message-user-action",
  "--lvis-message-user-emphasis",
  "--lvis-input-bar-bg",
  "--lvis-input-bar-fg",
  "--lvis-input-bar-placeholder",
  "--lvis-input-bar-border",
  "--lvis-input-bar-focus",
  "--lvis-input-bar-subtle",
  "--lvis-input-bar-action",
] as const;

const TYPOGRAPHY_AND_MOTION_TOKENS = [
  "--lvis-text-micro",
  "--lvis-text-caption",
  "--lvis-text-body-sm",
  "--lvis-text-body",
  "--lvis-leading-micro",
  "--lvis-leading-caption",
  "--lvis-leading-body-sm",
  "--lvis-leading-body",
  "--lvis-tracking-micro",
  "--lvis-tracking-caption",
  "--lvis-tracking-body-sm",
  "--lvis-tracking-body",
  "--lvis-motion-slow",
  "--lvis-motion-layout",
  "--lvis-motion-ease-standard",
  "--lvis-motion-ease-out",
  "--lvis-motion-ease-in-out",
] as const;

describe("LVIS_TOKEN_NAMES — complete public token contract", () => {
  it("includes all 7 new derived tokens", () => {
    for (const token of DERIVED_TOKENS) {
      expect(LVIS_TOKEN_NAMES).toContain(token);
    }
  });

  it("includes chat semantic aliases", () => {
    for (const token of CHAT_SEMANTIC_TOKENS) {
      expect(LVIS_TOKEN_NAMES).toContain(token);
    }
  });

  it("includes semantic typography and complete motion roles", () => {
    for (const token of TYPOGRAPHY_AND_MOTION_TOKENS) {
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
