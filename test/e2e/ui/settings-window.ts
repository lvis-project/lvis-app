import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';

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
  await app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const target = wins.find((w) => !w.isDestroyed() && w.getTitle() === 'LVIS 설정');
    if (!target) throw new Error('settings window not found for close');
    target.close();
  });
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
  await expect(settingsWindow.getByRole('heading', { name: '설정' })).toBeVisible({
    timeout: 10_000,
  });
  return settingsWindow;
}
