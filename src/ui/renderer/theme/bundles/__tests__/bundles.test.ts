import { describe, it, expect } from "vitest";
import { BUNDLES, DEFAULT_BUNDLE_ID, findBundle } from "../index.js";
import type { BundleTokens } from "../types.js";

/** All keys required in a BundleTokens object. */
const REQUIRED_TOKEN_KEYS: ReadonlyArray<keyof BundleTokens> = [
  /* Tier B — semantic shell */
  "background", "foreground",
  "card", "card-foreground",
  "popover", "popover-foreground",
  "primary", "primary-foreground",
  "secondary", "secondary-foreground",
  "muted", "muted-foreground",
  "accent", "accent-foreground",
  "destructive", "destructive-foreground",
  "warning", "warning-foreground",
  "success", "success-foreground",
  "border", "input", "ring", "ui-line",
  "message-user-bg", "message-user-fg",
  "input-bar-bg",
  /* Tier B' — status / state */
  "info", "info-foreground",
  "emphasis", "emphasis-foreground",
  /* Tier B'' — surface overlay + interaction */
  "overlay", "hover-overlay",
  "focus-ring", "link-fg",
  /* Tier B''' — peripheral system */
  "selection-bg", "selection-fg",
  "scrollbar-thumb", "scrollbar-track",
  "kbd-bg", "kbd-border",
  /* Tier C — code surface */
  "code-bg", "code-fg", "code-border",
  /* Tier D — chart palette */
  "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
  /* Action tokens */
  "action-view", "action-branch", "action-compact",
];

/** Basic HSL-value or raw triple pattern: "H S% L%" or "H S% L% / A%" */
const HSL_TRIPLE_RE = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%/;

describe("bundle registry", () => {
  it("exports exactly 16 bundles", () => {
    expect(BUNDLES).toHaveLength(16);
  });

  it("all bundle IDs are unique", () => {
    const ids = BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("default bundle ID resolves to a bundle", () => {
    expect(findBundle(DEFAULT_BUNDLE_ID)).toBeDefined();
  });

  it("starts fresh installs on the Moonstone light bundle", () => {
    expect(DEFAULT_BUNDLE_ID).toBe("moonstone");
    expect(BUNDLES[0].id).toBe("moonstone");
    expect(findBundle(DEFAULT_BUNDLE_ID)?.shell).toBe("light");
  });

  it("findBundle returns undefined for unknown id", () => {
    expect(findBundle("does-not-exist")).toBeUndefined();
  });

  it("exactly one high-contrast bundle is flagged", () => {
    const hc = BUNDLES.filter((b) => b.highContrast);
    expect(hc).toHaveLength(1);
    expect(hc[0].id).toBe("high-contrast");
  });
});

describe.each(BUNDLES.map((b) => [b.id, b] as [string, (typeof BUNDLES)[number]]))(
  "bundle %s",
  (_id, bundle) => {
    it("has id, name, description, shell, highContrast", () => {
      expect(typeof bundle.id).toBe("string");
      expect(bundle.id.length).toBeGreaterThan(0);
      expect(typeof bundle.name).toBe("string");
      expect(typeof bundle.description).toBe("string");
      expect(["light", "dark"]).toContain(bundle.shell);
      expect(typeof bundle.highContrast).toBe("boolean");
    });

    it("defines all required token keys", () => {
      for (const key of REQUIRED_TOKEN_KEYS) {
        expect(bundle.tokens).toHaveProperty(key);
      }
    });

    it("all token values are non-empty strings", () => {
      for (const key of REQUIRED_TOKEN_KEYS) {
        const val = bundle.tokens[key];
        expect(typeof val, `${key} should be a string`).toBe("string");
        expect(val.trim().length, `${key} should be non-empty`).toBeGreaterThan(0);
      }
    });

    it("all token values match HSL triple pattern", () => {
      for (const key of REQUIRED_TOKEN_KEYS) {
        const val = bundle.tokens[key];
        expect(HSL_TRIPLE_RE.test(val), `${key} = "${val}" should be an HSL triple`).toBe(true);
      }
    });

    it("shell matches color-scheme implied by background lightness", () => {
      // Heuristic: if background lightness > 50%, expect shell === "light"
      const bgVal = bundle.tokens.background;
      const match = bgVal.match(/(\d+(?:\.\d+)?%)$/);
      if (match) {
        const lightness = parseFloat(match[1]);
        if (lightness > 50) {
          expect(bundle.shell).toBe("light");
        } else if (lightness < 30) {
          expect(bundle.shell).toBe("dark");
        }
        // Values in between (30-50%) are ambiguous — no assertion
      }
    });
  },
);

describe("violet pair consistency", () => {
  it("violet-light and violet-dark share the same primary accent", () => {
    const light = findBundle("violet-light")!;
    const dark = findBundle("violet-dark")!;
    expect(light.tokens.primary).toBe(dark.tokens.primary);
    expect(light.tokens["message-user-bg"]).toBe(dark.tokens["message-user-bg"]);
    expect(light.tokens.destructive).toBe(dark.tokens.destructive);
  });

  it("violet-light is shell=light, violet-dark is shell=dark", () => {
    expect(findBundle("violet-light")!.shell).toBe("light");
    expect(findBundle("violet-dark")!.shell).toBe("dark");
  });
});

describe("high-contrast bundle invariants", () => {
  it("background is pure black", () => {
    const hc = findBundle("high-contrast")!;
    expect(hc.tokens.background).toBe("0 0% 0%");
  });

  it("primary is yellow (WCAG AA+)", () => {
    const hc = findBundle("high-contrast")!;
    expect(hc.tokens.primary).toBe("60 100% 50%");
  });

  it("border is pure white", () => {
    const hc = findBundle("high-contrast")!;
    expect(hc.tokens.border).toBe("0 0% 100%");
  });
});

describe("midnight bundle invariants", () => {
  it("primary is magenta hsl(290 80% 60%)", () => {
    const m = findBundle("midnight")!;
    expect(m.tokens.primary).toBe("290 80% 60%");
  });
});

describe("forest bundle invariants", () => {
  it("primary is teal hsl(170 70% 45%)", () => {
    const f = findBundle("forest")!;
    expect(f.tokens.primary).toBe("170 70% 45%");
  });
});

describe("executive graphite bundle invariants", () => {
  it("uses restrained graphite surfaces with a teal work accent", () => {
    const g = findBundle("executive-graphite")!;
    expect(g.shell).toBe("dark");
    expect(g.tokens.background).toBe("24 8% 8%");
    expect(g.tokens.primary).toBe("174 65% 45%");
    expect(g.tokens["action-branch"]).toBe("38 86% 62%");
  });
});
