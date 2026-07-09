import { test, expect } from './fixtures';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// R5 verification: Settings is an always-inline panel (no detached window) and
// its shell is responsive — master-detail on a wide panel, a 2-depth stack
// (category list → detail with a back button) on a narrow one. The layout is
// driven by the PANEL width, so shrinking the app window flips it.

const OUT = process.env.LVIS_SHOT_DIR ?? join(process.cwd(), 'test-results', 'settings-shots');

async function setWindowSize(app: import('@playwright/test').ElectronApplication, w: number, h: number) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed() && x.isVisible());
    const target = wins.sort((a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1])[0];
    if (target) target.setContentSize(size.w, size.h);
  }, { w, h });
}

test('Settings inline shell is responsive (wide master-detail ↔ narrow 2-depth)', async ({ app, mainWindow }) => {
  mkdirSync(OUT, { recursive: true });

  // Open settings INLINE (the openSettingsWindow IPC now redirects to the inline
  // panel — no BrowserWindow is created).
  await mainWindow.evaluate(() => {
    const api = (window as unknown as { lvisApi: { openSettingsWindow: (t?: string) => unknown } }).lvisApi;
    void api.openSettingsWindow('llm');
  });
  await expect(mainWindow.getByTestId('settings-sidebar-heading')).toBeVisible({ timeout: 15_000 });

  // ---- WIDE: master-detail ----
  await setWindowSize(app, 1180, 860);
  const root = mainWindow.locator('[data-settings-layout]');
  await expect.poll(async () => root.getAttribute('data-settings-layout'), { timeout: 5_000 }).toBe('wide');
  await expect(mainWindow.getByTestId('settings-mobile-list')).toHaveCount(0);
  writeFileSync(join(OUT, '1-desktop-master-detail.png'), await mainWindow.screenshot());

  // ---- NARROW depth 1: category list ----
  await setWindowSize(app, 400, 820);
  await expect.poll(async () => root.getAttribute('data-settings-layout'), { timeout: 5_000 }).toBe('narrow');
  await expect(mainWindow.getByTestId('settings-mobile-list')).toBeVisible();
  writeFileSync(join(OUT, '2-mobile-list.png'), await mainWindow.screenshot());

  // ---- NARROW depth 2: drill into a section, back button appears ----
  await mainWindow.getByRole('tab', { name: /Model|모델/ }).first().click();
  await expect(mainWindow.getByTestId('settings-mobile-back')).toBeVisible();
  writeFileSync(join(OUT, '3-mobile-detail.png'), await mainWindow.screenshot());

  // back returns to the list
  await mainWindow.getByTestId('settings-mobile-back').click();
  await expect(mainWindow.getByTestId('settings-mobile-list')).toBeVisible();
});
