import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';

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
