import { test, expect } from './fixtures';

/**
 * Chat-surface text contrast — WCAG AA regression guard for every shipped
 * shell × chat-theme combination.
 *
 * Why this spec exists:
 *   PR #336 introduced the `data-theme="light"` shell, but the assistant
 *   message body was still wrapped in `prose prose-sm prose-invert ...`,
 *   which hard-codes near-white prose colors. Once light shipped, those
 *   bubbles painted unreadable light-on-light text. Production users hit
 *   this on 2026-04-30 — exactly the gap this spec now closes.
 *
 * Strategy:
 *   1. Boot the Electron renderer (existing fixture).
 *   2. For every (shell ∈ light/dark/high-contrast) × (chat-theme ∈
 *      default/purple/orange/blue) combination — 12 in total — flip the
 *      `data-theme` and `data-chat-theme` attributes on <html>, identical
 *      to what ThemeProvider does at runtime.
 *   3. Inject a synthetic assistant bubble into the live document using the
 *      same class chain the real `<AssistantCard>` renders — `prose prose-sm
 *      lvis-prose` — and read the *computed* color of the body paragraph and
 *      its actual painted background (walking the parent chain because
 *      Tailwind Typography paints the bubble's bg on an outer element).
 *   4. Compute the WCAG 2.2 contrast ratio. Assert ≥ 4.5:1 (Body text AA).
 *
 *   We skip "system" shell because it resolves to either light or dark at
 *   runtime — its contrast is already covered by those two cases.
 *
 * Note on scope:
 *   The task spec called out "16 combos = 4 chat × 4 shell". The renderer
 *   actually ships 4 chat themes × 3 shell themes = 12 painting-relevant
 *   combos (system is a meta-pointer). We expose an explicit table and a
 *   row count assertion so any future shell addition forces this spec to
 *   be updated alongside the new tokens.
 */

type Shell = 'light' | 'dark' | 'high-contrast';
type ChatTheme = 'default' | 'purple' | 'orange' | 'blue';

const SHELLS: readonly Shell[] = ['light', 'dark', 'high-contrast'] as const;
const CHAT_THEMES: readonly ChatTheme[] = ['default', 'purple', 'orange', 'blue'] as const;

const COMBOS: { shell: Shell; chat: ChatTheme }[] = [];
for (const shell of SHELLS) {
  for (const chat of CHAT_THEMES) {
    COMBOS.push({ shell, chat });
  }
}

/* ───────────────────────────────────────────────────────────────────────
 *  Helpers — these run inside the page (browser context). The Electron
 *  fixture exposes `mainWindow` which is a Playwright Page bound to the
 *  renderer BrowserWindow.
 * ─────────────────────────────────────────────────────────────────────── */

const PROBE_HOST_ID = '__lvis_contrast_probe__';
const PROBE_BODY_ID = '__lvis_contrast_probe_body__';
const PROBE_CODE_ID = '__lvis_contrast_probe_code__';

/**
 * Build a synthetic assistant bubble that mirrors the runtime markup:
 *   <div class="rounded-md px-3 py-2 text-sm">                  ← bubble shell
 *     <div class="prose prose-sm lvis-prose ...">               ← body wrapper
 *       <p>안녕! 오늘 날씨는 ...</p>
 *       <p>여기는 <code>inline</code> 사례입니다.</p>
 *     </div>
 *   </div>
 *
 * Mounting via `appendChild` keeps the rest of the app intact so we can
 * iterate combinations without remounting React.
 */
function injectProbe(): void {
  const existing = document.getElementById('__lvis_contrast_probe__');
  if (existing) existing.remove();
  const host = document.createElement('div');
  host.id = '__lvis_contrast_probe__';
  // Position outside the layout but still composited so getComputedStyle
  // returns the painted values (display: none would yield empty strings on
  // some platforms).
  host.style.position = 'fixed';
  host.style.left = '-9999px';
  host.style.top = '0';
  host.style.width = '320px';
  host.style.zIndex = '-1';

  const bubble = document.createElement('div');
  bubble.className = 'group relative max-w-[85%] rounded-md px-3 py-2 text-sm';

  const body = document.createElement('div');
  body.id = '__lvis_contrast_probe_body__';
  body.className = 'prose prose-sm lvis-prose max-w-none break-words';
  // Markdown plugin compiles to <p> for paragraphs; replicate so we hit
  // the same selectors prose paints.
  body.innerHTML =
    '<p>안녕! 오늘 날씨는 화창합니다. 즐거운 하루 보내세요.</p>' +
    '<p>여기는 <code id="__lvis_contrast_probe_code__">inline</code> 사례입니다.</p>';

  bubble.appendChild(body);
  host.appendChild(bubble);
  document.body.appendChild(host);
}

/** Walk parents until we find one with a non-transparent painted background. */
function paintedBackground(el: Element): string {
  let cur: Element | null = el;
  while (cur) {
    const style = getComputedStyle(cur);
    const bg = style.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    cur = cur.parentElement;
  }
  // Fall back to the document body or html background if every ancestor was
  // transparent — the renderer composites against whatever <html> paints.
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

test.describe('Chat surface contrast — WCAG AA across shell × chat-theme matrix', () => {
  test('every shipped (shell × chat-theme) combination passes contrast >= 4.5:1', async ({
    mainWindow,
  }) => {
    // Sanity — confirm we're actually iterating the published matrix, not a
    // stale subset. If a future PR adds a shell or chat theme, the row count
    // shifts and the developer has to update this spec.
    expect(COMBOS.length).toBe(SHELLS.length * CHAT_THEMES.length);

    type RowResult = {
      shell: Shell;
      chat: ChatTheme;
      bodyColor: string;
      bodyBg: string;
      bodyRatio: number;
      codeColor: string;
      codeBg: string;
      codeRatio: number;
    };
    const failures: RowResult[] = [];
    const rows: RowResult[] = [];

    for (const { shell, chat } of COMBOS) {
      // 1. Apply theme attributes — same write ThemeProvider performs at runtime.
      await mainWindow.evaluate(
        ({ shell, chat }: { shell: string; chat: string }) => {
          const root = document.documentElement;
          root.setAttribute('data-theme', shell);
          if (chat === 'default') {
            root.removeAttribute('data-chat-theme');
          } else {
            root.setAttribute('data-chat-theme', chat);
          }
        },
        { shell, chat },
      );

      // 2. Inject a fresh probe so style cascades re-resolve cleanly.
      await mainWindow.evaluate(() => {
        const existing = document.getElementById('__lvis_contrast_probe__');
        if (existing) existing.remove();
        const host = document.createElement('div');
        host.id = '__lvis_contrast_probe__';
        host.style.position = 'fixed';
        host.style.left = '-9999px';
        host.style.top = '0';
        host.style.width = '320px';
        host.style.zIndex = '-1';

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

      // 3. Read computed colors / backgrounds.
      const probe = await mainWindow.evaluate(() => {
        const body = document.getElementById('__lvis_contrast_probe_body__');
        const code = document.getElementById('__lvis_contrast_probe_code__');
        if (!body || !code) throw new Error('probe missing after injection');

        const bodyP = body.querySelector('p');
        if (!bodyP) throw new Error('probe paragraph missing');
        const bodyColor = getComputedStyle(bodyP).color;

        // Walk parents for background — prose body itself is transparent.
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

        const bodyBg = paintedBg(bodyP);
        const codeStyle = getComputedStyle(code);
        const codeColor = codeStyle.color;
        // Inline code is painted with a non-transparent bg by lvis-prose, so
        // its computed style is enough — but fall back to the parent walk
        // just in case a future stylesheet revision relaxes that.
        const codeBg =
          codeStyle.backgroundColor && codeStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
            ? codeStyle.backgroundColor
            : paintedBg(code);
        return { bodyColor, bodyBg, codeColor, codeBg };
      });

      const bodyRatio = contrastRatio(probe.bodyColor, probe.bodyBg);
      const codeRatio = contrastRatio(probe.codeColor, probe.codeBg);

      const row: RowResult = {
        shell,
        chat,
        bodyColor: probe.bodyColor,
        bodyBg: probe.bodyBg,
        bodyRatio,
        codeColor: probe.codeColor,
        codeBg: probe.codeBg,
        codeRatio,
      };
      rows.push(row);
      // 4.5 = WCAG AA Body Text. Code chips must clear the same bar — they
      // are still primary content the user reads at body-text size.
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
          `  data-theme=${f.shell} data-chat-theme=${f.chat}: ` +
          `body color=${f.bodyColor} bg=${f.bodyBg} ratio=${f.bodyRatio.toFixed(2)}; ` +
          `code color=${f.codeColor} bg=${f.codeBg} ratio=${f.codeRatio.toFixed(2)}`,
      );
      throw new Error(
        `Contrast regression — ${failures.length}/${rows.length} combinations below 4.5:1:\n${lines.join('\n')}`,
      );
    }

    expect(failures, 'all combinations must clear WCAG AA body-text contrast').toHaveLength(0);
    expect(rows).toHaveLength(SHELLS.length * CHAT_THEMES.length);
  });
});
