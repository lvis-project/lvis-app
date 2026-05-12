import { test, expect } from './fixtures';
import { BUNDLE_IDS } from '../../../src/shared/theme-bundles.js';

/**
 * Theme bundle smoke — for each declared BundleId, set `data-theme-bundle`
 * on <html> and verify:
 *   1. The attribute round-trips (resolver contract).
 *   2. `getComputedStyle(body).backgroundColor` becomes non-empty / non-
 *      transparent — i.e. every bundle defines `--background` and the body's
 *      `bg-background` Tailwind utility resolves to a real color.
 *   3. The renderer keeps painting (no white-on-white / black-on-black
 *      catastrophic failure) — we sample `<body>` text color and assert it
 *      differs from the bg by at least 50 in summed RGB luminance.
 *   4. Switching to a known-different bundle produces a different bg color
 *      (smoke that the CSS variable swap actually happens).
 *
 * Direct DOM attribute injection bypasses the React theme provider — this is
 * the actual contract that `resolveTheme` writes to. Provider-level testing is
 * covered by vitest snapshots.
 */

function parseRgb(rgb: string): [number, number, number] | null {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance(rgb: [number, number, number]): number {
  return rgb[0] + rgb[1] + rgb[2];
}

test('every theme bundle resolves to a paintable surface', async ({ mainWindow }) => {
  const bgs = new Map<string, string>();
  for (const id of BUNDLE_IDS) {
    const result = await mainWindow.evaluate((bundleId) => {
      document.documentElement.setAttribute('data-theme-bundle', bundleId);
      const cs = getComputedStyle(document.body);
      return {
        attr: document.documentElement.getAttribute('data-theme-bundle'),
        bg: cs.backgroundColor,
        fg: cs.color,
      };
    }, id);

    expect(result.attr, `data-theme-bundle should round-trip for ${id}`).toBe(id);
    expect(result.bg, `${id} bg must be set (non-empty)`).not.toBe('');
    expect(result.bg, `${id} bg must be a real color (not transparent)`).not.toMatch(
      /rgba?\(0,\s*0,\s*0,\s*0\)/,
    );

    const bg = parseRgb(result.bg);
    const fg = parseRgb(result.fg);
    expect(bg, `${id} bg should parse as rgb()`).not.toBeNull();
    expect(fg, `${id} fg should parse as rgb()`).not.toBeNull();
    const contrast = Math.abs(luminance(bg!) - luminance(fg!));
    expect(
      contrast,
      `${id} body fg vs bg must have ≥50 summed-RGB delta (got ${contrast})`,
    ).toBeGreaterThanOrEqual(50);

    bgs.set(id, result.bg);
  }

  /* Smoke that the CSS variable swap actually happens: at least one bundle
     must paint a different body bg than tokyo-night. (We don't assert every
     bundle is unique — high-contrast/midnight legitimately share base hues
     with tokyo-night on some tokens.) */
  const tokyoBg = bgs.get('tokyo-night');
  const distinct = Array.from(bgs.values()).filter((bg) => bg !== tokyoBg);
  expect(
    distinct.length,
    'at least 8 of 12 bundles should produce a bg different from tokyo-night',
  ).toBeGreaterThanOrEqual(8);
});
