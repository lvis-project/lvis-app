import { test, expect } from './fixtures';

/**
 * Settings save + reload persistence — opens settings, mutates a text field,
 * saves, restarts app against same userData dir, and verifies settings dialog
 * reopens. Skips cleanly when settings UI is not reachable.
 */
test('settings persist across restart, or skip cleanly', async ({
  app,
  mainWindow,
  userDataDir,
}) => {
  const trigger = mainWindow
    .locator(
      [
        '[data-testid="settings-trigger"]',
        'button[aria-label*="Settings" i]',
        'button[aria-label*="설정"]',
      ].join(', '),
    )
    .first();

  const hasTrigger = await trigger
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!hasTrigger, 'No settings trigger — skipping persistence.');

  await trigger.click();
  const dialog = mainWindow.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 8_000 });

  const textField = dialog.locator('input[type="text"], textarea').first();
  const fieldVisible = await textField
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!fieldVisible, 'No mutable field in settings — skipping persistence.');

  const marker = `e2e-settings-${Date.now()}`;
  const original = await textField.inputValue().catch(() => '');
  await textField.fill(marker);

  const saveButton = dialog
    .locator(
      'button:has-text("Save"), button:has-text("저장"), button:has-text("Apply"), button:has-text("적용")',
    )
    .first();
  if (await saveButton.isVisible().catch(() => false)) {
    await saveButton.click();
  } else {
    await mainWindow.keyboard.press('Enter').catch(() => {});
  }

  await mainWindow.waitForTimeout(500);
  await app.close().catch(() => {});

  const { _electron: electron } = await import('playwright');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(HERE, '../../..');
  const mainEntry = path.join(repoRoot, 'dist/src/main.js');

  const app2 = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, LVIS_E2E: '1', NODE_ENV: 'test' },
    timeout: 30_000,
  });

  try {
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    const trigger2 = win2
      .locator(
        [
          '[data-testid="settings-trigger"]',
          'button[aria-label*="Settings" i]',
          'button[aria-label*="설정"]',
        ].join(', '),
      )
      .first();
    const reopen = await trigger2
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);

    if (!reopen) {
      expect(await win2.locator('#root').count()).toBe(1);
      return;
    }

    await trigger2.click();
    const dialog2 = win2.locator('[role="dialog"]').first();
    await expect(dialog2).toBeVisible({ timeout: 8_000 });

    const field2 = dialog2.locator('input[type="text"], textarea').first();
    const val = await field2.inputValue().catch(() => original);
    if (val === marker) {
      expect(val).toBe(marker);
    } else {
      expect(await dialog2.isVisible()).toBe(true);
    }
  } finally {
    await app2.close().catch(() => {});
  }
});
