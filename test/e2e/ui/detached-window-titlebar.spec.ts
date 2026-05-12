import { test, expect } from './fixtures';

/**
 * DetachedView titlebar — B1 CustomTitleBar integration (#354 follow-up).
 *
 * Opens a detached window by navigating to the detached hash route directly
 * (the same mechanism used by WindowManager.openDetached) and asserts that
 * the drag region provided by <CustomTitleBar /> is present.
 *
 * The test uses a second Electron window rather than an in-app context menu
 * because that path requires a fully booted Python runtime. Instead we load
 * index.html#detached/tasks in a new BrowserWindow
 * via the Playwright `waitForEvent('window')` pattern.
 */

test('detached window exposes CustomTitleBar drag region', async ({ app, mainWindow }) => {
  // Wait for the main window to be ready before triggering a detached open.
  await mainWindow.waitForLoadState('domcontentloaded');

  // Listen for a new window before triggering navigation.
  const newWindowPromise = app.waitForEvent('window');

  // Navigate the main window renderer to open a detached window via the
  // window.lvisApi bridge if available, otherwise open the URL directly in
  // a new BrowserWindow via Electron evaluation.
  await app.evaluate(async ({ BrowserWindow, screen }, mainEntry) => {
    const preloadPath = mainEntry.replace('main.js', 'preload.cjs');
    const win = new BrowserWindow({
      width: 600,
      height: 500,
      show: false,
      frame: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: false,
        preload: preloadPath,
      },
    });
    // Load the detached route
    const indexPath = mainEntry.replace('main.js', 'index.html');
    await win.loadFile(indexPath, { hash: 'detached/tasks' });
    win.show();
    // @ts-ignore — screen access
    void screen;
  }, process.env.LVIS_MAIN_ENTRY ?? '');

  const detachedPage = await newWindowPromise;
  await detachedPage.waitForLoadState('domcontentloaded');

  // Assert that at least one CustomTitleBar drag region is present.
  // CustomTitleBar renders either data-testid="custom-titlebar-darwin" (macOS)
  // or data-testid="custom-titlebar" (Win/Linux).
  const darwinBar = detachedPage.locator('[data-testid="custom-titlebar-darwin"]');
  const winBar = detachedPage.locator('[data-testid="custom-titlebar"]');

  const hasDarwin = await darwinBar.count().catch(() => 0);
  const hasWin = await winBar.count().catch(() => 0);

  expect(
    hasDarwin + hasWin,
    'DetachedView must render CustomTitleBar (drag region missing)',
  ).toBeGreaterThanOrEqual(1);
});
