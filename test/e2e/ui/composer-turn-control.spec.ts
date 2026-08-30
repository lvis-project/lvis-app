/**
 * E2E: composer turn control + dock strip + edit bubble, verified against
 * COMPUTED style in the real Electron window.
 *
 * These four defects were all invisible to the renderer unit tests because
 * every one of them is a *resolved style* failure, not a markup failure: the
 * markup was right and the paint was wrong. They only surface once real CSS
 * (the theme layer, the Tailwind build and tailwind-merge's conflict
 * resolution) has run, which is exactly what this spec exercises.
 */
import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

/**
 * The side chat renders the SAME composer, queue panel, and turn control as the
 * main dock, with the same test ids. Every locator that means "the main dock's
 * X" is anchored on the dock's surface marker so it cannot resolve to the side
 * chat's copy — and so a second match is a real failure rather than something
 * `.first()` quietly hides.
 */
const MAIN = '[data-composer-surface="main"] ';

/** Parse a computed `rgb(...)` / `rgba(...)` string into channels. */
function parseRgb(value: string): [number, number, number] {
  const nums = value.match(/[\d.]+/g);
  if (!nums || nums.length < 3) throw new Error(`unparseable colour: ${value}`);
  return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
}

/**
 * WCAG relative-luminance contrast ratio. "The two colours are not literally
 * equal" is far too weak a check for a legibility regression: when
 * `text-primary-foreground` was dropped, the label painted at rgb(31,33,41)
 * on rgb(27,29,34) — different values, contrast ratio 1.03, invisible.
 */
function contrastRatio(a: string, b: string): number {
  const luminance = (colour: string) => {
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, bl] = parseRgb(colour);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
  };
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('idle composer: the turn control is a quiet, icon-only send button', async ({ mainWindow }) => {
  const send = mainWindow.locator(MAIN + '[data-testid="composer-send-button"]');
  await expect(send).toBeVisible();
  // Send and stop are ONE button — no separate stop control exists at idle.
  await expect(mainWindow.locator(MAIN + '[data-testid="composer-cancel-button"]')).toHaveCount(0);

  const idle = await send.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      background: cs.backgroundColor,
      borderWidth: cs.borderTopWidth,
      label: (el.textContent ?? '').trim(),
      keycaps: el.querySelectorAll('kbd').length,
      glyphs: el.querySelectorAll('svg').length,
      ariaLabel: el.getAttribute('aria-label'),
    };
  });

  // No text label and no keycap: the old markup shipped a "Send" span plus a ⏎
  // keycap whose chip and glyph both resolved to `primary-foreground`, so the
  // glyph vanished into its own chip and the control read as a blank box.
  expect(idle.label).toBe('');
  expect(idle.keycaps).toBe(0);
  expect(idle.glyphs).toBe(1);
  expect(idle.ariaLabel).toBeTruthy();

  // Quiet, not a disabled solid disc: a disabled solid primary paints a
  // near-black circle at 50% opacity, which reads as broken rather than idle.
  expect(idle.borderWidth).not.toBe('0px');
});

test('typing turns the quiet control solid', async ({ mainWindow }) => {
  const send = mainWindow.locator(MAIN + '[data-testid="composer-send-button"]');
  const before = await send.evaluate((el) => getComputedStyle(el).backgroundColor);

  const textarea = mainWindow.locator(MAIN + testIdSelector(TEST_IDS.composerTextarea));
  await textarea.click();
  await textarea.fill('ep 세션 유지 시간 확인할 수 있나?');

  const after = await send.evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    borderWidth: getComputedStyle(el).borderTopWidth,
  }));
  expect(after.background).not.toBe(before);
  expect(after.borderWidth).toBe('0px');
});

test('message queue panel stays a full-bleed band and paints visible actions', async ({ mainWindow }) => {
  await mainWindow.evaluate(() => {
    const store = (window as unknown as { __lvis_message_queue_store__?: { add: (t: string) => void } })
      .__lvis_message_queue_store__;
    store?.add('계속 확인해봐');
  });

  const panel = mainWindow.locator(MAIN + '[data-testid="message-queue-panel"]');
  await expect(panel).toBeVisible();
  const inject = mainWindow.locator(MAIN + '[data-testid="message-queue-row-send-now-button"]').first();
  await expect(inject).toBeVisible();

  const measured = await panel.evaluate((el) => {
    const panelBox = el.getBoundingClientRect();
    // Measure against the dock column the strip lives in, NOT <main>: <main>
    // spans the whole window including the sidebar, so nothing inside the dock
    // can align with it — which is why the equivalent assertion in
    // session-todo-in-chat.spec.ts is red on main too.
    const dockBox = document
      .querySelector('[data-testid="session-todo-dock"]')
      ?.getBoundingClientRect();
    const injectEl = el.querySelector('[data-testid="message-queue-row-send-now-button"]')!;
    // The panel's own tint is 5% alpha, so the effective backdrop is the
    // nearest OPAQUE ancestor background — that is what the label competes with.
    let opaque: HTMLElement | null = el as HTMLElement;
    let behindPanel = 'rgb(255, 255, 255)';
    while (opaque) {
      const bg = getComputedStyle(opaque).backgroundColor;
      const alpha = bg.match(/[\d.]+/g);
      const isOpaque = bg.startsWith('rgb(') || (alpha && alpha.length === 4 && Number(alpha[3]) === 1);
      if (isOpaque) { behindPanel = bg; break; }
      opaque = opaque.parentElement;
    }
    return {
      left: Math.round(panelBox.left),
      right: Math.round(panelBox.right),
      dockLeft: dockBox ? Math.round(dockBox.left) : null,
      dockRight: dockBox ? Math.round(dockBox.right) : null,
      injectWidth: Math.round(injectEl.getBoundingClientRect().width),
      injectColor: getComputedStyle(injectEl).color,
      behindPanel,
    };
  });

  // Dock strips are BANDS filling the dock column; only the composer is an
  // inset card. Insetting this one made the two siblings disagree.
  expect(measured.left).toBe(measured.dockLeft);
  expect(measured.right).toBe(measured.dockRight);

  // The inject action used to be painted with `--accent`, a pale SURFACE token,
  // so it disappeared against the panel. It must render with real width and
  // enough contrast against what is actually behind it to be readable.
  expect(measured.injectWidth).toBeGreaterThan(0);
  expect(contrastRatio(measured.injectColor, measured.behindPanel)).toBeGreaterThanOrEqual(4.5);
});

test('edit bubble is a single frame with a readable save button', async ({ mainWindow }) => {
  const textarea = mainWindow.locator(MAIN + '[data-testid="composer-textarea"]');
  await textarea.click();
  await textarea.fill('ep 세션 유지 시간 확인할 수 있나?');
  await mainWindow.locator(MAIN + '[data-testid="composer-send-button"]').click();

  const actions = mainWindow.locator('[data-testid="user-message-actions"]').first();
  await expect(actions).toBeAttached({ timeout: 15_000 });
  await actions.locator('button').first().click({ force: true });

  const bubble = mainWindow.locator('[data-testid="user-message-editor"]');
  await expect(bubble).toBeVisible({ timeout: 10_000 });

  const measured = await bubble.evaluate((el) => {
    const inner = el.querySelector('textarea')!;
    const save = el.querySelector('[data-testid="user-message-editor-save"]')!;
    const saveCs = getComputedStyle(save);
    return {
      bubbleBorderWidth: getComputedStyle(el).borderTopWidth,
      innerBorderWidth: getComputedStyle(inner).borderTopWidth,
      saveLabel: (save.textContent ?? '').trim(),
      saveColor: saveCs.color,
      saveBackground: saveCs.backgroundColor,
    };
  });

  // One frame: the bubble draws it, the textarea inside draws none.
  expect(measured.bubbleBorderWidth).not.toBe('0px');
  expect(measured.innerBorderWidth).toBe('0px');

  // The save button carried `text-caption`, which tailwind-merge mistook for a
  // colour and used to drop `text-primary-foreground` — the label then painted
  // in the ambient dark colour on a near-black button and vanished.
  expect(measured.saveLabel.length).toBeGreaterThan(0);
  expect(contrastRatio(measured.saveColor, measured.saveBackground)).toBeGreaterThanOrEqual(4.5);
});
