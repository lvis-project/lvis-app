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
import { violetLightBundle } from "../bundles/violet-light.js";
import { violetDarkBundle } from "../bundles/violet-dark.js";
import { highContrastBundle } from "../bundles/high-contrast.js";
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

describe("bundleToPluginTokens — derived value snapshot (architect fix #4)", () => {
  it("keeps plugin motion tokens aligned to host motion timings", () => {
    const tokens = bundleToPluginTokens(tokyoNightBundle);

    expect(tokens["--lvis-motion-fast"]).toBe("120ms");
    expect(tokens["--lvis-motion-normal"]).toBe("180ms");
  });

  it("derives --lvis-success-fg from the active bundle", () => {
    const tokens = bundleToPluginTokens(violetDarkBundle);

    expect(tokens["--lvis-success-fg"]).toBe("hsl(0, 0%, 5%)");
  });

  it("derives --lvis-primary-bg-subtle correctly per shell mode", () => {
    const light = bundleToPluginTokens(violetLightBundle);
    const dark  = bundleToPluginTokens(violetDarkBundle);
    const hc    = bundleToPluginTokens(highContrastBundle);

    // light shell: primarySubtlePct = 14
    expect(light["--lvis-primary-bg-subtle"]).toMatch(/color-mix\(in srgb,.*14%/);
    // dark shell: primarySubtlePct = 18
    expect(dark["--lvis-primary-bg-subtle"]).toMatch(/color-mix\(in srgb,.*18%/);
    // high-contrast: primarySubtlePct = 24
    expect(hc["--lvis-primary-bg-subtle"]).toMatch(/color-mix\(in srgb,.*24%/);
  });

  it("derives --lvis-primary-bg-strong correctly per shell mode", () => {
    const light = bundleToPluginTokens(violetLightBundle);
    const dark  = bundleToPluginTokens(violetDarkBundle);
    const hc    = bundleToPluginTokens(highContrastBundle);

    // light: 28%, dark: 32%, hc: 40%
    expect(light["--lvis-primary-bg-strong"]).toMatch(/color-mix\(in srgb,.*28%/);
    expect(dark["--lvis-primary-bg-strong"]).toMatch(/color-mix\(in srgb,.*32%/);
    expect(hc["--lvis-primary-bg-strong"]).toMatch(/color-mix\(in srgb,.*40%/);
  });

  it("derives --lvis-surface-hover correctly per shell mode", () => {
    const light = bundleToPluginTokens(violetLightBundle);
    const dark  = bundleToPluginTokens(violetDarkBundle);
    const hc    = bundleToPluginTokens(highContrastBundle);

    // light: 6%, dark: 10%, hc: 14%
    expect(light["--lvis-surface-hover"]).toMatch(/color-mix\(in srgb,.*6%/);
    expect(dark["--lvis-surface-hover"]).toMatch(/color-mix\(in srgb,.*10%/);
    expect(hc["--lvis-surface-hover"]).toMatch(/color-mix\(in srgb,.*14%/);
  });

  it("derives --lvis-focus-shadow as ring-based color-mix at 62%", () => {
    const light = bundleToPluginTokens(violetLightBundle);
    const dark  = bundleToPluginTokens(violetDarkBundle);
    const hc    = bundleToPluginTokens(highContrastBundle);

    // focus-shadow is invariant to shell mode — always 62% ring over transparent
    expect(light["--lvis-focus-shadow"]).toMatch(/color-mix\(in srgb,.*62%/);
    expect(dark["--lvis-focus-shadow"]).toMatch(/color-mix\(in srgb,.*62%/);
    expect(hc["--lvis-focus-shadow"]).toMatch(/color-mix\(in srgb,.*62%/);
  });
});
