import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';
import { openSettingsWindow } from './settings-window';

/**
 * Settings save + reload persistence through the native settings BrowserWindow.
 */
test('native settings save persists privacy redaction setting', async ({
  app,
  mainWindow,
  userDataDir,
}) => {
  const settingsPath = path.join(userDataDir, 'lvis-settings.json');
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'chat');
  const redactToggle = settingsWindow.getByRole('checkbox', { name: /PII 리댁트 활성화/ });

  await expect(redactToggle).toBeVisible({ timeout: 10_000 });
  if ((await redactToggle.getAttribute('aria-checked')) !== 'true') {
    await redactToggle.click();
  }
  await expect(redactToggle).toHaveAttribute('aria-checked', 'true');

  const closePromise = settingsWindow.waitForEvent('close');
  const saveButton = settingsWindow.getByRole('button', { name: '저장' });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();
  await closePromise;

  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.privacy?.piiRedactEnabled;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe(true);

  const reopenedSettingsWindow = await openSettingsWindow(app, mainWindow, 'chat');
  await expect(
    reopenedSettingsWindow.getByRole('checkbox', { name: /PII 리댁트 활성화/ }),
  ).toHaveAttribute('aria-checked', 'true');
  await reopenedSettingsWindow.close();
});
