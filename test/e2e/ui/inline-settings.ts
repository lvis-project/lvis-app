import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';

/**
 * Settings is now an ALWAYS-INLINE panel (settings-inline-overhaul) — there is
 * no detached settings BrowserWindow in either app mode. The helpers return the
 * MAIN window because settings renders inline inside it; every
 * `settingsPage.getByX` call resolves against that same page.
 *
 * The inline shell is responsive — it flips to a narrow 2-depth stack (a
 * category list that drills into a detail pane) once the settings panel is
 * narrower than ~640px, which would hide the tab content behind the depth-1
 * list. Most specs expect the selected tab's content to be immediately
 * visible, so `openInlineSettings` forces a WIDE content size before opening.
 * That makes the master-detail (both-regions-visible) layout deterministic
 * regardless of the headless display's work-area size. Specs that specifically
 * exercise the narrow/mobile shell drive the window size themselves (see
 * settings-responsive.spec.ts) and do not use this helper.
 */

const WIDE_CONTENT_WIDTH = 1200;
const WIDE_CONTENT_HEIGHT = 860;
type MainWindowBounds = { x: number; y: number; width: number; height: number };
const originalMainWindowBounds = new WeakMap<ElectronApplication, MainWindowBounds>();

/** Resize the largest visible app window (the main window) to a wide size. */
async function forceWideMainWindow(app: ElectronApplication): Promise<void> {
  const originalBounds = await app.evaluate(({ BrowserWindow }, size) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    if (!target) return null;
    const bounds = target.getBounds();
    target.setContentSize(size.w, size.h);
    return bounds;
  }, { w: WIDE_CONTENT_WIDTH, h: WIDE_CONTENT_HEIGHT });
  if (originalBounds && !originalMainWindowBounds.has(app)) {
    originalMainWindowBounds.set(app, originalBounds);
  }
}

async function restoreMainWindowBounds(app: ElectronApplication): Promise<void> {
  const bounds = originalMainWindowBounds.get(app);
  if (!bounds) return;
  await app.evaluate(({ BrowserWindow }, original) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    target?.setBounds(original);
  }, bounds);
  originalMainWindowBounds.delete(app);
}

/**
 * Open the inline settings panel and return the main window. The test injects
 * the same trusted main-to-renderer `view:activate` event used by native menu,
 * tray, and deep-link entry points; no renderer-to-main window IPC exists.
 */
export async function openInlineSettings(
  app: ElectronApplication,
  mainWindow: Page,
  initialTab = 'llm',
): Promise<Page> {
  await forceWideMainWindow(app);
  await app.evaluate(({ BrowserWindow }, tab) => {
    const wins = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    if (!target) throw new Error('main window is unavailable');
    target.webContents.send('lvis:view:activate', { viewKey: 'settings', settingsTab: tab });
  }, initialTab);

  // Locale-stable readiness gate: the settings shell is mounted. Its own layout
  // marker says so in either layout — the panel used to carry a title of its
  // own to gate on and does not any more, because the pane header names it now.
  await expect(mainWindow.locator('[data-settings-layout]')).toBeVisible({ timeout: 15_000 });
  // The panel-width ResizeObserver may still be settling right after the resize;
  // wait until the shell has committed to the wide layout so tab content (not a
  // depth-1 category list) is what's on screen.
  await expect
    .poll(
      async () =>
        mainWindow.locator('[data-settings-layout]').getAttribute('data-settings-layout'),
      { timeout: 5_000 },
    )
    .toBe('wide');
  return mainWindow;
}

/**
 * Leave the inline settings panel through the shared history navbar. Settings
 * tab moves are first-class view-history entries, so a spec that visited several
 * tabs needs more than one back step before it reaches the preceding app view.
 * Replaying at most the history cap plus its fallback step makes cleanup
 * deterministic while preserving the product's browser-style history contract.
 * Once SettingsContent unmounts, a subsequent open remounts it and re-reads
 * persisted state.
 */
export async function closeInlineSettings(
  app: ElectronApplication,
  settingsPage: Page,
): Promise<void> {
  const layout = settingsPage.locator('[data-settings-layout]');
  const currentPath = settingsPage.locator('[data-testid^="view-path-current-"]').first();

  try {
    for (let step = 0; step < 52; step += 1) {
      if (await layout.count() === 0) return;

      const before = await currentPath.getAttribute('data-testid') ?? `settings-step-${step}`;
      const back = settingsPage.getByTestId('view-path-back');
      await expect(back).toBeEnabled();
      await back.click();
      await expect.poll(async () => {
        if (await layout.count() === 0) return '__settings_closed__';
        return await currentPath.getAttribute('data-testid') ?? '__settings_open__';
      }, { timeout: 10_000 }).not.toBe(before);
    }

    throw new Error('settings history did not reach a non-settings view within 52 back steps');
  } finally {
    await restoreMainWindowBounds(app);
  }
}
