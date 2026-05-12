/**
 * Issue #616 — tripleToHsl alpha-channel support.
 *
 * Bundle tokens are stored as bare HSL triples in the Tailwind format. The
 * format optionally includes an alpha component (`"H S% L% / A"` or
 * `"H S% L% / A%"`). The previous parser only accepted `"H S% L%"` and
 * silently returned the raw triple when alpha was present, which would
 * inject an unparseable string into plugin webview CSS (plugins consume
 * the rewrapped `hsl()` form, not raw triples).
 *
 * This test mints a synthetic ThemeBundle with one alpha-bearing token
 * and asserts the resolved plugin token is a valid `hsla()` value.
 */
import { describe, it, expect } from "vitest";
import { bundleToPluginTokens } from "../plugin-token-map.js";
import { tokyoNightBundle } from "../bundles/tokyo-night.js";
import type { ThemeBundle } from "../bundles/types.js";

function withTokens(base: ThemeBundle, overrides: Partial<ThemeBundle["tokens"]>): ThemeBundle {
  return { ...base, tokens: { ...base.tokens, ...overrides } };
}

describe("tripleToHsl — alpha channel support (issue #616)", () => {
  it("wraps a no-alpha triple as hsl(H, S%, L%)", () => {
    const tokens = bundleToPluginTokens(tokyoNightBundle);
    expect(tokens["--lvis-bg"]).toMatch(/^hsl\(\d+(?:\.\d+)?, \d+(?:\.\d+)?%, \d+(?:\.\d+)?%\)$/);
  });

  it("wraps a triple with `/ A%` alpha as hsla(H, S%, L%, A%)", () => {
    const bundle = withTokens(tokyoNightBundle, { background: "222.2 84% 4.9% / 80%" });
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--lvis-bg"]).toBe("hsla(222.2, 84%, 4.9%, 80%)");
  });

  it("wraps a triple with `/ A` (unitless) alpha as hsla(H, S%, L%, A)", () => {
    const bundle = withTokens(tokyoNightBundle, { foreground: "210 40% 98% / 0.5" });
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--lvis-fg"]).toBe("hsla(210, 40%, 98%, 0.5)");
  });

  it("passes raw values through when the triple does not match either form", () => {
    const bundle = withTokens(tokyoNightBundle, { primary: "var(--p-blue-500)" });
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--lvis-primary"]).toBe("var(--p-blue-500)");
  });
});
