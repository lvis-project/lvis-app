import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';
import { openSettingsWindow } from './settings-window';

/**
 * Settings → Appearance 탭의 외부 URL 표시 정책 토글 e2e.
 */
test('webView.preferredFlow toggle persists to settings.json', async ({
  app,
  mainWindow,
  userDataDir,
}) => {
  const settingsPath = path.join(userDataDir, 'lvis-settings.json');
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'appearance');

  const radiogroup = settingsWindow.locator('[data-testid="webview-preferred-flow"]').first();
  await expect(radiogroup).toBeVisible({ timeout: 10_000 });

  const systemBrowserBtn = radiogroup.locator('[data-value="system-browser"]').first();
  await systemBrowserBtn.click();

  // Wait for the IPC roundtrip to flush settings.json.
  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.webView?.preferredFlow;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe('system-browser');

  await expect(systemBrowserBtn).toHaveAttribute('aria-checked', 'true');

  // Toggle back to in-app — verify the IPC also persists the reverse path.
  const inAppBtn = radiogroup.locator('[data-value="in-app"]').first();
  await inAppBtn.click();
  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.webView?.preferredFlow;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe('in-app');

  await settingsWindow.close();
});
