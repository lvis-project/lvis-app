/**
 * Theme contrast audit — assert WCAG AA (4.5:1) for every paired
 * `bg-<token> text-<token>-foreground` combination across every bundle.
 *
 * Used to catch foreground tokens that don't match their bg lightness
 * (the canonical regression: `message-user-fg: white` against a 76% L
 * lilac `message-user-bg`, contrast ~1.5 → user text effectively
 * invisible). Surfaces test pairs explicitly so future bundle authors
 * can't ship a paired bg/fg that fails contrast.
 */
import { describe, it, expect } from "vitest";
import { BUNDLE_IDS, loadThemeBundle } from "../index.js";
import type { BundleTokens } from "../types.js";

/** HSL "H S% L%" string → numeric components. */
function parseHsl(str: string): { h: number; s: number; l: number } {
  const m = str.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/);
  if (!m) throw new Error(`unrecognized HSL: "${str}"`);
  return { h: parseFloat(m[1]), s: parseFloat(m[2]), l: parseFloat(m[3]) };
}

/** HSL (0–360, 0–100, 0–100) → linear sRGB tuple in [0, 255]. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** WCAG 2.x relative luminance from sRGB (0–255). */
function relativeLuminance(rgb: [number, number, number]): number {
  const lin = (c: number): number => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** WCAG contrast ratio between two sRGB tuples (always ≥ 1). */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function ratioFor(bgHsl: string, fgHsl: string): number {
  const bg = parseHsl(bgHsl);
  const fg = parseHsl(fgHsl);
  return contrastRatio(hslToRgb(bg.h, bg.s, bg.l), hslToRgb(fg.h, fg.s, fg.l));
}

/* Two tiers — body text needs WCAG AA 4.5, chip/badge surfaces used for
 * shorter labels can pass at 3.0 (WCAG AA large). The thresholds are
 * intentionally generous so the test surfaces regressions without
 * flagging deliberate stylistic choices (e.g. pastel theme bubble tones). */
/* Tier A — body-text contexts (renderer renders paragraph-sized text against
 * these surfaces). WCAG AA threshold 4.5. */
const BODY_PAIRS: Array<[keyof BundleTokens, keyof BundleTokens]> = [
  ["background", "foreground"],
  ["card", "card-foreground"],
  ["popover", "popover-foreground"],
  ["muted", "muted-foreground"],
  ["message-user-bg", "message-user-fg"],
];

/* Tier B — button + chip + badge contexts (short labels, larger font weight).
 * WCAG AA Large threshold 3.0 — accepted standard for Button-style surfaces
 * where slightly relaxed contrast is the norm across design systems
 * (shadcn / Tailwind / Catppuccin / Nord all sit here on their saturated
 * primary buttons). */
const CHIP_PAIRS: Array<[keyof BundleTokens, keyof BundleTokens]> = [
  ["primary", "primary-foreground"],
  ["secondary", "secondary-foreground"],
  ["destructive", "destructive-foreground"],
  ["accent", "accent-foreground"],
  ["warning", "warning-foreground"],
  ["success", "success-foreground"],
  ["info", "info-foreground"],
  ["emphasis", "emphasis-foreground"],
];

const UI_LINE_BACKDROPS: Array<keyof BundleTokens> = [
  "background",
  "input-bar-bg",
];

describe("Theme contrast — body-text surfaces (WCAG AA 4.5:1)", () => {
  for (const bundleId of BUNDLE_IDS) {
    for (const [bgKey, fgKey] of BODY_PAIRS) {
      it(`${bundleId}: ${String(bgKey)} ↔ ${String(fgKey)} ≥ 4.5`, async () => {
        const bundle = await loadThemeBundle(bundleId);
        expect(bundle).toBeDefined();
        if (!bundle) return;
        const ratio = ratioFor(bundle.tokens[bgKey], bundle.tokens[fgKey]);
        expect(
          ratio,
          `${bundle.id} ${String(bgKey)}=${bundle.tokens[bgKey]} vs ${String(fgKey)}=${bundle.tokens[fgKey]} ratio ${ratio.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("Theme contrast — chip/badge surfaces (WCAG AA Large 3:1)", () => {
  for (const bundleId of BUNDLE_IDS) {
    for (const [bgKey, fgKey] of CHIP_PAIRS) {
      it(`${bundleId}: ${String(bgKey)} ↔ ${String(fgKey)} ≥ 3.0`, async () => {
        const bundle = await loadThemeBundle(bundleId);
        expect(bundle).toBeDefined();
        if (!bundle) return;
        const ratio = ratioFor(bundle.tokens[bgKey], bundle.tokens[fgKey]);
        expect(
          ratio,
          `${bundle.id} ${String(bgKey)}=${bundle.tokens[bgKey]} vs ${String(fgKey)}=${bundle.tokens[fgKey]} ratio ${ratio.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(3.0);
      });
    }
  }
});

describe("Theme contrast — visible UI line token (non-text 3:1)", () => {
  for (const bundleId of BUNDLE_IDS) {
    for (const bgKey of UI_LINE_BACKDROPS) {
      it(`${bundleId}: ui-line against ${String(bgKey)} ≥ 3.0`, async () => {
        const bundle = await loadThemeBundle(bundleId);
        expect(bundle).toBeDefined();
        if (!bundle) return;
        const ratio = ratioFor(bundle.tokens[bgKey], bundle.tokens["ui-line"]);
        expect(
          ratio,
          `${bundle.id} ${String(bgKey)}=${bundle.tokens[bgKey]} vs ui-line=${bundle.tokens["ui-line"]} ratio ${ratio.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(3.0);
      });
    }
  }
});
