import { test, expect } from './fixtures';
import { STATUS_BAR_IDENTITY_EMOJIS } from '../../../src/shared/status-bar-emojis.js';

/**
 * Status bar (#231) emoji redesign smoke — verifies the bottom status bar
 * renders emoji-based identity glyphs, uses `|` as inter-item separator, and stacks platform emoji
 * fonts so Apple Color Emoji (macOS) / Segoe UI Emoji (Windows) / Noto Color
 * Emoji (Linux) render natively.
 *
 * No pixel comparison — emoji glyphs are OS-specific and would produce
 * flaky baselines across Mac/Win/Linux. We assert DOM/CSS signals only and
 * attach a debug screenshot for post-hoc inspection.
 */
test('status bar renders emoji identity glyphs and | separator', async ({ mainWindow }) => {
  const statusBar = mainWindow.locator('[data-testid="status-bar"]');

  await statusBar.waitFor({ state: 'visible', timeout: 10_000 });

  // The status bar may show the LVIS placeholder before any producer emits.
  await mainWindow.waitForFunction(
    (markers) => {
      const bar = document.querySelector('[data-testid="status-bar"]');
      if (bar === null) return false;
      const text = bar.textContent ?? '';
      return markers.some((m) => text.includes(m));
    },
    STATUS_BAR_IDENTITY_EMOJIS,
    { timeout: 15_000 },
  );

  const text = (await statusBar.textContent()) ?? '';
  await test.info().attach('status-bar-text', { body: text, contentType: 'text/plain' });
  await test.info().attach('status-bar-screenshot', {
    body: await statusBar.screenshot(),
    contentType: 'image/png',
  });

  const emojiMatches = STATUS_BAR_IDENTITY_EMOJIS.filter((m) => text.includes(m));

  // At least one identity emoji is present once producers populate.
  expect(emojiMatches.length).toBeGreaterThan(0);

  // Multi-item rendering implies a `|` separator between items. We accept
  // single-item state (no separator) as valid because env/marketplace can
  // be absent depending on config.
  if (emojiMatches.length >= 2) {
    expect(text).toContain('|');
  }
});

test('status bar emoji label uses platform emoji font stack + a11y split', async ({ mainWindow }) => {
  const statusBar = mainWindow.locator('[data-testid="status-bar"]');
  await statusBar.waitFor({ state: 'visible', timeout: 10_000 });

  // The emoji glyph is rendered inside an aria-hidden span so screen readers
  // don't announce the Unicode emoji name ("wrench"). The semantic label is
  // a sibling sr-only span supplied by the producer (e.g. "도구 개수").
  const emojiSpan = statusBar.locator('span[data-status-bar-emoji="true"][aria-hidden="true"]').first();
  await emojiSpan.waitFor({ state: 'visible', timeout: 10_000 });

  const fontFamily = await emojiSpan.evaluate((el) => (el as HTMLElement).style.fontFamily);
  expect(fontFamily).toContain('Apple Color Emoji');
  expect(fontFamily).toContain('Segoe UI Emoji');
  expect(fontFamily).toContain('Noto Color Emoji');

  // Screen-reader sr-only label must accompany the emoji so SR users hear a
  // semantic phrase instead of the emoji's Unicode name.
  const srLabel = statusBar.locator('span.sr-only').first();
  await srLabel.waitFor({ state: 'attached', timeout: 5_000 });
  const srText = (await srLabel.textContent()) ?? '';
  expect(srText.length).toBeGreaterThan(0);
});

test('status bar does NOT render the deprecated env/account producer', async ({ mainWindow }) => {
  const statusBar = mainWindow.locator('[data-testid="status-bar"]');
  await statusBar.waitFor({ state: 'visible', timeout: 10_000 });

  const text = (await statusBar.textContent()) ?? '';

  // The env producer used to emit "<platform> · <user>@<hostname>". A `@`
  // glyph in the bar would imply the producer is still wired. Toasts on
  // the right slot may legitimately carry `@` (e.g. plugin slugs) so we
  // narrow the assertion to the left persistent area pattern.
  const looksLikeAccount = /[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+/.test(text);
  expect(looksLikeAccount).toBe(false);
});
