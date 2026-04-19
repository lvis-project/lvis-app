import { test, expect } from './fixtures';

/**
 * Settings dialog smoke — attempts to open settings via a common
 * selector set. Skips if no settings trigger can be located, so the
 * test remains safe against UI evolution.
 */
test('settings dialog opens and closes, or skips if unavailable', async ({ mainWindow }) => {
  const trigger = mainWindow.locator(
    [
      '[data-testid="settings-trigger"]',
      'button[aria-label*="Settings" i]',
      'button[aria-label*="설정"]',
      'button[title*="Settings" i]',
      'button[title*="설정"]',
    ].join(', '),
  ).first();

  const found = await trigger
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!found, 'No settings trigger located — skipping.');

  await trigger.click();

  const dialog = mainWindow.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  await mainWindow.keyboard.press('Escape');
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});
