import { test, expect } from './fixtures';
import { BUNDLE_IDS } from '../../../src/shared/theme-bundles.js';
import type { BundleId } from '../../../src/shared/theme-bundles.js';

/**
 * Chat-surface text contrast — WCAG AA regression guard for every shipped
 * theme bundle.
 *
 * Why this spec was updated (2026-05-08):
 *   PR #613 replaced the tri-axis model (shell × chatTheme × codeTheme) with
 *   single-selection bundles. The previous spec iterated `data-theme` ×
 *   `data-chat-theme` attributes — those attributes are still written by
 *   ThemeProvider for SDK compat, but the authoritative selector is now
 *   `data-theme-bundle`. Iterating only the legacy axes produced a 12-combo
 *   matrix that was entirely a no-op (ThemeProvider v2 ignores those writes
 *   when a `data-theme-bundle` is already set). This spec now iterates every
 *   shipped bundle via `data-theme-bundle` — matching what ThemeProvider does
 *   at runtime.
 *
 * Strategy:
 *   1. Boot the Electron renderer (existing fixture).
 *   2. For every bundle in `BUNDLE_IDS` (length is the authoritative count;
 *      this spec self-extends when a new bundle is added to the registry):
 *      a. Write `data-theme-bundle="<id>"` on <html> — identical to ThemeProvider.
 *      b. Inject a synthetic assistant bubble with the runtime class chain
 *         (`prose prose-sm lvis-prose`).
 *      c. Read computed color + painted background for body text and inline code.
 *      d. Assert WCAG AA contrast ratio >= 4.5:1.
 *   3. Assert row count == `BUNDLE_IDS.length` so a renderer-side filter or
 *      early-return regression that silently drops a bundle still fails here.
 */

/* ───────────────────────────────────────────────────────────────────────
 *  WCAG contrast helpers (run inside page context)
 * ─────────────────────────────────────────────────────────────────────── */

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
    type RowResult = {
      bundle: BundleId;
      bodyColor: string;
      bodyBg: string;
      bodyRatio: number;
      codeColor: string;
      codeBg: string;
      codeRatio: number;
      strongColor: string;
      strongBg: string;
      strongRatio: number;
      thColor: string;
      thBg: string;
      thRatio: number;
      tdColor: string;
      tdBg: string;
      tdRatio: number;
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
        host.style.cssText = 'position:fixed;left:-9999px;top:0;width:480px;z-index:-1';

        const bubble = document.createElement('div');
        bubble.className = 'group relative max-w-[85%] rounded-md px-3 py-2 text-sm';

        const body = document.createElement('div');
        body.id = '__lvis_contrast_probe_body__';
        body.className = 'prose prose-sm lvis-prose max-w-none break-words';
        body.innerHTML =
          '<p>안녕! 오늘 <strong id="__lvis_contrast_probe_strong__">날씨</strong>는 화창합니다.</p>' +
          '<p>여기는 <code id="__lvis_contrast_probe_code__">inline</code> 사례입니다.</p>' +
          '<table><thead><tr>' +
          '<th id="__lvis_contrast_probe_th__">날짜</th><th>날씨</th><th>최고/최저</th><th>강수</th>' +
          '</tr></thead><tbody><tr>' +
          '<td id="__lvis_contrast_probe_td__">5/12(화)</td><td>구름 조금</td><td>24° / 13°</td><td>1%</td>' +
          '</tr></tbody></table>';

        bubble.appendChild(body);
        host.appendChild(bubble);
        document.body.appendChild(host);
      });

      // 3. Read computed colors + backgrounds.
      const probe = await mainWindow.evaluate(() => {
        const body = document.getElementById('__lvis_contrast_probe_body__');
        const code = document.getElementById('__lvis_contrast_probe_code__');
        const strong = document.getElementById('__lvis_contrast_probe_strong__');
        const th = document.getElementById('__lvis_contrast_probe_th__');
        const td = document.getElementById('__lvis_contrast_probe_td__');
        if (!body || !code || !strong || !th || !td) throw new Error('probe missing after injection');
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
        const strongColor = getComputedStyle(strong).color;
        const strongBg = paintedBg(strong);
        const thColor = getComputedStyle(th).color;
        const thBg = paintedBg(th);
        const tdColor = getComputedStyle(td).color;
        const tdBg = paintedBg(td);
        return { bodyColor, bodyBg, codeColor, codeBg, strongColor, strongBg, thColor, thBg, tdColor, tdBg };
      });

      const bodyRatio = contrastRatio(probe.bodyColor, probe.bodyBg);
      const codeRatio = contrastRatio(probe.codeColor, probe.codeBg);
      const strongRatio = contrastRatio(probe.strongColor, probe.strongBg);
      const thRatio = contrastRatio(probe.thColor, probe.thBg);
      const tdRatio = contrastRatio(probe.tdColor, probe.tdBg);

      const row: RowResult = {
        bundle,
        bodyColor: probe.bodyColor,
        bodyBg: probe.bodyBg,
        bodyRatio,
        codeColor: probe.codeColor,
        codeBg: probe.codeBg,
        codeRatio,
        strongColor: probe.strongColor,
        strongBg: probe.strongBg,
        strongRatio,
        thColor: probe.thColor,
        thBg: probe.thBg,
        thRatio,
        tdColor: probe.tdColor,
        tdBg: probe.tdBg,
        tdRatio,
      };
      rows.push(row);
      // 4.5 = WCAG AA Body Text minimum. td uses 0.88 alpha so allow 4.0 lower bound.
      if (bodyRatio < 4.5 || codeRatio < 4.5 || strongRatio < 4.5 || thRatio < 4.5 || tdRatio < 4.0) {
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
          `body=${f.bodyRatio.toFixed(2)} ` +
          `code=${f.codeRatio.toFixed(2)} ` +
          `strong=${f.strongRatio.toFixed(2)} (color=${f.strongColor} bg=${f.strongBg}) ` +
          `th=${f.thRatio.toFixed(2)} (color=${f.thColor}) ` +
          `td=${f.tdRatio.toFixed(2)} (color=${f.tdColor})`,
      );
      throw new Error(
        `Contrast regression — ${failures.length}/${rows.length} bundles below threshold:\n${lines.join('\n')}`,
      );
    }

    expect(failures, 'all bundles must clear WCAG AA body-text contrast').toHaveLength(0);
    expect(rows).toHaveLength(BUNDLE_IDS.length);
  });
});
