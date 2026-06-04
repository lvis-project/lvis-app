import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { translate } from '../../../src/i18n/translate.js';
import { SUPPORTED_LOCALES } from '../../../src/i18n/locale.js';

// The settings window title is localized (be_main.settingsWindowTitle). Resolve
// it for every supported locale so the helpers work whatever the suite seeds.
const SETTINGS_WINDOW_TITLES = SUPPORTED_LOCALES.map((l) =>
  translate(l, 'be_main.settingsWindowTitle'),
);

/**
 * Close the native settings window from the main process. The settings window
 * is launched with the default OS chrome (no CustomTitleBar / no in-DOM close
 * button), so end-users close it through the OS title bar X. In a headless
 * xvfb run there is no usable system chrome, so we close via the Electron
 * BrowserWindow API and wait for the renderer page's `close` event.
 */
export async function closeSettingsWindow(
  app: ElectronApplication,
  settingsWindow: Page,
): Promise<void> {
  const closed = settingsWindow.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }, titles) => {
    const wins = BrowserWindow.getAllWindows();
    const target = wins.find((w) => !w.isDestroyed() && titles.includes(w.getTitle()));
    if (!target) throw new Error('settings window not found for close');
    target.close();
  }, SETTINGS_WINDOW_TITLES);
  await closed;
}

export async function openSettingsWindow(
  app: ElectronApplication,
  mainWindow: Page,
  initialTab = 'llm',
): Promise<Page> {
  const settingsWindowPromise = app.waitForEvent('window', { timeout: 10_000 });
  const result = await mainWindow.evaluate(async (tab) => {
    const api = (window as unknown as {
      lvisApi?: {
        openSettingsWindow?: (initialTab?: string) => Promise<{ ok: boolean; error?: string }>;
      };
    }).lvisApi;
    if (!api?.openSettingsWindow) {
      throw new Error('window.lvisApi.openSettingsWindow is not available');
    }
    return api.openSettingsWindow(tab);
  }, initialTab);

  if (!result.ok) {
    throw new Error(result.error ?? 'Failed to open native settings window');
  }

  const settingsWindow = await settingsWindowPromise;
  await settingsWindow.waitForLoadState('domcontentloaded');
  // Wait on the sidebar heading by testid — locale-stable, so the helper works
  // whatever locale the suite seeds (previously matched the Korean "설정" text).
  await expect(
    settingsWindow.getByTestId('settings-sidebar-heading'),
  ).toBeVisible({ timeout: 10_000 });
  return settingsWindow;
}
