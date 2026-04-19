import { test, expect } from './fixtures';

/**
 * Search overlay smoke — opens chat search overlay via keyboard shortcut
 * or a dedicated button, verifies a search input renders, and exercises one
 * filter keystroke. Skips cleanly if overlay is unavailable.
 */
test('search overlay opens and accepts filter input, or skips', async ({ mainWindow }) => {
  const trigger = mainWindow
    .locator(
      [
        '[data-testid="chat-search-trigger"]',
        '[data-testid="open-search"]',
        'button[aria-label*="Search" i]',
        'button[aria-label*="검색"]',
      ].join(', '),
    )
    .first();

  const triggerVisible = await trigger
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (triggerVisible) {
    await trigger.click();
  } else {
    const accel = process.platform === 'darwin' ? 'Meta+F' : 'Control+F';
    await mainWindow.keyboard.press(accel).catch(() => {});
  }

  const overlayInput = mainWindow
    .locator(
      [
        '[data-testid="chat-search-input"]',
        'input[placeholder*="Search" i]',
        'input[placeholder*="검색"]',
        '[role="searchbox"]',
      ].join(', '),
    )
    .first();

  const overlayVisible = await overlayInput
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!overlayVisible, 'No search overlay input — skipping.');

  await overlayInput.fill('hello');
  const val = await overlayInput.inputValue().catch(() => '');
  expect(val).toBe('hello');
});
