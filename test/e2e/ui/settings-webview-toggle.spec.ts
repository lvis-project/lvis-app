import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

/**
 * Settings → Web / Browsing 탭의 외부 URL 표시 정책 토글 e2e. (The control was
 * relocated from the Appearance tab to the Web tab in the settings IA restructure.)
 */
test('webView.preferredFlow toggle persists to settings.json', async ({
  app,
  mainWindow,
  userDataDir,
}) => {
  const settingsPath = path.join(userDataDir, 'lvis-settings.json');
  const settingsPage = await openInlineSettings(app, mainWindow, 'web');

  const radiogroup = settingsPage.locator('[data-testid="webview-preferred-flow"]').first();
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

  await closeInlineSettings(app, settingsPage);
});
