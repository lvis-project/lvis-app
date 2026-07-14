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
import { LVIS_TOKEN_NAMES } from "../../../../shared/plugin-ui-tokens.js";

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
  it("emits every public token exactly once", () => {
    const tokens = bundleToPluginTokens(tokyoNightBundle);

    expect(Object.keys(tokens).sort()).toEqual([...LVIS_TOKEN_NAMES].sort());
    for (const name of LVIS_TOKEN_NAMES) {
      expect(tokens[name], name).toBeTruthy();
    }
  });

  it("keeps plugin motion tokens aligned to host motion timings", () => {
    const tokens = bundleToPluginTokens(tokyoNightBundle);

    expect(tokens["--lvis-motion-fast"]).toBe("120ms");
    expect(tokens["--lvis-motion-normal"]).toBe("180ms");
    expect(tokens["--lvis-motion-slow"]).toBe("240ms");
    expect(tokens["--lvis-motion-layout"]).toBe("300ms");
    expect(tokens["--lvis-motion-ease-standard"]).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(tokens["--lvis-motion-ease-out"]).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(tokens["--lvis-motion-ease-in-out"]).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
  });

  it("exposes the host semantic typography rhythm", () => {
    const tokens = bundleToPluginTokens(tokyoNightBundle);

    expect(tokens["--lvis-text-micro"]).toBe("0.75rem");
    expect(tokens["--lvis-leading-micro"]).toBe("1rem");
    expect(tokens["--lvis-tracking-micro"]).toBe("0.015em");
    expect(tokens["--lvis-text-caption"]).toBe("0.75rem");
    expect(tokens["--lvis-leading-caption"]).toBe("1.125rem");
    expect(tokens["--lvis-text-body-sm"]).toBe("0.875rem");
    expect(tokens["--lvis-leading-body-sm"]).toBe("1.25rem");
    expect(tokens["--lvis-text-body"]).toBe("1rem");
    expect(tokens["--lvis-leading-body"]).toBe("1.5rem");
  });

  it("aliases chat roles from the active bundle without a second color source", () => {
    const tokens = bundleToPluginTokens(violetLightBundle);

    expect(tokens["--lvis-message-user-bg"]).toBe("hsl(271, 76%, 76%)");
    expect(tokens["--lvis-message-user-border"]).toBe(tokens["--lvis-message-user-fg"]);
    expect(tokens["--lvis-message-user-muted"]).toBe(tokens["--lvis-message-user-fg"]);
    expect(tokens["--lvis-message-user-action"]).toBe(tokens["--lvis-message-user-fg"]);
    expect(tokens["--lvis-message-user-emphasis"]).toBe(tokens["--lvis-message-user-fg"]);
    expect(tokens["--lvis-input-bar-fg"]).toBe(tokens["--lvis-fg"]);
    expect(tokens["--lvis-input-bar-placeholder"]).toBe(
      "hsla(0, 0%, 15%, 0.82)",
    );
    expect(tokens["--lvis-input-bar-focus"]).toBe(tokens["--lvis-ring"]);
    expect(tokens["--lvis-input-bar-action"]).toBe(tokens["--lvis-fg"]);
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
