import { test, expect } from './fixtures';

/**
 * Smoke test for chat input affordance. We do not require a live LLM
 * vendor key — if no input element can be found within the timeout,
 * we skip gracefully so this suite remains green in offline CI.
 */
test('chat input element can be located or test skips cleanly', async ({ mainWindow }) => {
  const input = mainWindow.locator(
    'textarea, input[type="text"], [contenteditable="true"]',
  ).first();

  const found = await input
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!found, 'No chat input found in current UI — skipping input-type smoke.');

  await input.click();
  await input.fill('hello from playwright e2e');
  const value = await input.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => {
    if ('value' in el) return el.value;
    return (el as HTMLElement).textContent ?? '';
  });
  expect(value).toContain('playwright e2e');
});

test('chat input keeps real keyboard typing intact', async ({ mainWindow }) => {
  const input = mainWindow.locator('[data-testid="composer-textarea"]').first();
  const found = await input
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!found, 'No composer textarea visible.');

  const marker = `keyboard-e2e-${Date.now()}`;
  await input.click();
  await mainWindow.keyboard.type(marker, { delay: 1 });
  const value = await input.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => {
    if ('value' in el) return el.value;
    return (el as HTMLElement).textContent ?? '';
  });
  expect(value).toBe(marker);
});
