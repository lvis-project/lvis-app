import { test, expect } from './fixtures';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DIST_SRC = path.join(REPO_ROOT, 'dist/src');

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
  // Build dist layout has divergent sibling paths — main.js lives in
  // `dist/src/main/`, preload.cjs in `dist/src/`, and index.html in
  // `dist/src/`. The prior `mainEntry.replace('main.js', 'preload.cjs')`
  // shortcut assumed they were all in the same directory and broke after
  // the build layout split. Resolve each path from `dist/src/` explicitly.
  await app.evaluate(async ({ BrowserWindow, screen }, paths) => {
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
        preload: paths.preload,
      },
    });
    // Load the detached route
    await win.loadFile(paths.index, { hash: 'detached/tasks' });
    win.show();
    // @ts-ignore — screen access
    void screen;
  }, {
    // Build layout: dist/src/preload.cjs + dist/src/index.html
    // (main.js lives one dir deeper at dist/src/main/main.js, so we resolve
    // siblings from `dist/src/` directly — derived in the test process
    // because `app.evaluate` runs in Electron's main process where
    // `process.env.LVIS_MAIN_ENTRY` is undefined unless explicitly seeded).
    preload: path.join(DIST_SRC, 'preload.cjs'),
    index: path.join(DIST_SRC, 'index.html'),
  });

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
