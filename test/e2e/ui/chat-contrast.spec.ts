import { test, expect } from './fixtures';

/**
 * Chat-surface text contrast — WCAG AA regression guard for every shipped
 * theme bundle.
 *
 * Why this spec was updated (2026-05-08):
 *   PR #613 replaced the tri-axis model (shell × chatTheme × codeTheme) with
 *   6 single-selection bundles. The previous spec iterated `data-theme` ×
 *   `data-chat-theme` attributes — those attributes are still written by
 *   ThemeProvider for SDK compat, but the authoritative selector is now
 *   `data-theme-bundle`. Iterating only the legacy axes produced a 12-combo
 *   matrix that was entirely a no-op (ThemeProvider v2 ignores those writes
 *   when a `data-theme-bundle` is already set). This spec now iterates all 6
 *   bundles via `data-theme-bundle` — matching what ThemeProvider does at runtime.
 *
 * Strategy:
 *   1. Boot the Electron renderer (existing fixture).
 *   2. For every bundle in BUNDLE_IDS (6 total):
 *      a. Write `data-theme-bundle="<id>"` on <html> — identical to ThemeProvider.
 *      b. Inject a synthetic assistant bubble with the runtime class chain
 *         (`prose prose-sm lvis-prose`).
 *      c. Read computed color + painted background for body text and inline code.
 *      d. Assert WCAG AA contrast ratio >= 4.5:1.
 *   3. Assert row count == 6 so a future bundle addition forces this spec to
 *      be updated.
 */

const BUNDLE_IDS = [
  'tokyo-night',
  'midnight',
  'forest',
  'lge-light',
  'lge-dark',
  'high-contrast',
] as const;

type BundleId = (typeof BUNDLE_IDS)[number];

const PROBE_BODY_ID = '__lvis_contrast_probe_body__';

/* ───────────────────────────────────────────────────────────────────────
 *  WCAG contrast helpers (run inside page context)
 * ─────────────────────────────────────────────────────────────────────── */

/** Walk parents until we find one with a non-transparent painted background. */
function paintedBackground(el: Element): string {
  let cur: Element | null = el;
  while (cur) {
    const style = getComputedStyle(cur);
    const bg = style.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    cur = cur.parentElement;
  }
  return getComputedStyle(document.documentElement).backgroundColor || 'rgb(255, 255, 255)';
}

/** Parse "rgb(r, g, b)" / "rgba(r, g, b, a)" into [r,g,b] in 0..1. */
function rgbToTuple(input: string): [number, number, number] {
  const m = input.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
  if (!m) throw new Error(`unparseable color string: ${input}`);
  const r = parseFloat(m[1]!) / 255;
  const g = parseFloat(m[2]!) / 255;
  const b = parseFloat(m[3]!) / 255;
  return [r, g, b];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(fg: string, bg: string): number {
  const fl = relativeLuminance(rgbToTuple(fg));
  const bl = relativeLuminance(rgbToTuple(bg));
  const [hi, lo] = fl > bl ? [fl, bl] : [bl, fl];
  return (hi + 0.05) / (lo + 0.05);
}

/* ───────────────────────────────────────────────────────────────────────
 *  Spec
 * ─────────────────────────────────────────────────────────────────────── */

test.describe('Chat surface contrast — WCAG AA across all 6 theme bundles', () => {
  test('every bundle passes contrast >= 4.5:1 for body text and inline code', async ({
    mainWindow,
  }) => {
    // Sanity — row count assertion so a future bundle addition forces this spec to update.
    expect(BUNDLE_IDS.length).toBe(6);

    type RowResult = {
      bundle: BundleId;
      bodyColor: string;
      bodyBg: string;
      bodyRatio: number;
      codeColor: string;
      codeBg: string;
      codeRatio: number;
    };
    const failures: RowResult[] = [];
    const rows: RowResult[] = [];

    for (const bundle of BUNDLE_IDS) {
      // 1. Apply bundle — same write ThemeProvider v2 performs at runtime.
      await mainWindow.evaluate(
        ({ bundleId }: { bundleId: string }) => {
          document.documentElement.setAttribute('data-theme-bundle', bundleId);
        },
        { bundleId: bundle },
      );

      // 2. Inject a fresh assistant bubble probe so style cascades re-resolve cleanly.
      await mainWindow.evaluate(() => {
        const PROBE_HOST_ID = '__lvis_contrast_probe__';
        document.getElementById(PROBE_HOST_ID)?.remove();
        const host = document.createElement('div');
        host.id = PROBE_HOST_ID;
        host.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;z-index:-1';

        const bubble = document.createElement('div');
        bubble.className = 'group relative max-w-[85%] rounded-md px-3 py-2 text-sm';

        const body = document.createElement('div');
        body.id = '__lvis_contrast_probe_body__';
        body.className = 'prose prose-sm lvis-prose max-w-none break-words';
        body.innerHTML =
          '<p>안녕! 오늘 날씨는 화창합니다. 즐거운 하루 보내세요.</p>' +
          '<p>여기는 <code id="__lvis_contrast_probe_code__">inline</code> 사례입니다.</p>';

        bubble.appendChild(body);
        host.appendChild(bubble);
        document.body.appendChild(host);
      });

      // 3. Read computed colors + backgrounds.
      const probe = await mainWindow.evaluate(() => {
        const body = document.getElementById('__lvis_contrast_probe_body__');
        const code = document.getElementById('__lvis_contrast_probe_code__');
        if (!body || !code) throw new Error('probe missing after injection');
        const bodyP = body.querySelector('p');
        if (!bodyP) throw new Error('probe paragraph missing');

        function paintedBg(el: Element): string {
          let cur: Element | null = el;
          while (cur) {
            const style = getComputedStyle(cur);
            const bg = style.backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
            cur = cur.parentElement;
          }
          return getComputedStyle(document.documentElement).backgroundColor || 'rgb(255, 255, 255)';
        }

        const bodyColor = getComputedStyle(bodyP).color;
        const bodyBg = paintedBg(bodyP);
        const codeStyle = getComputedStyle(code);
        const codeColor = codeStyle.color;
        const codeBg =
          codeStyle.backgroundColor && codeStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
            ? codeStyle.backgroundColor
            : paintedBg(code);
        return { bodyColor, bodyBg, codeColor, codeBg };
      });

      const bodyRatio = contrastRatio(probe.bodyColor, probe.bodyBg);
      const codeRatio = contrastRatio(probe.codeColor, probe.codeBg);

      const row: RowResult = {
        bundle,
        bodyColor: probe.bodyColor,
        bodyBg: probe.bodyBg,
        bodyRatio,
        codeColor: probe.codeColor,
        codeBg: probe.codeBg,
        codeRatio,
      };
      rows.push(row);
      // 4.5 = WCAG AA Body Text minimum.
      if (bodyRatio < 4.5 || codeRatio < 4.5) {
        failures.push(row);
      }
    }

    // 4. Cleanup probe so subsequent specs in the same worker don't see it.
    await mainWindow.evaluate(() => {
      document.getElementById('__lvis_contrast_probe__')?.remove();
    });

    if (failures.length > 0) {
      const lines = failures.map(
        (f) =>
          `  bundle=${f.bundle}: ` +
          `body color=${f.bodyColor} bg=${f.bodyBg} ratio=${f.bodyRatio.toFixed(2)}; ` +
          `code color=${f.codeColor} bg=${f.codeBg} ratio=${f.codeRatio.toFixed(2)}`,
      );
      throw new Error(
        `Contrast regression — ${failures.length}/${rows.length} bundles below 4.5:1:\n${lines.join('\n')}`,
      );
    }

    expect(failures, 'all bundles must clear WCAG AA body-text contrast').toHaveLength(0);
    expect(rows).toHaveLength(BUNDLE_IDS.length);
  });
});
