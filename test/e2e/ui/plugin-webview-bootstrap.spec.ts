import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

type PluginViewSummary = {
  pluginId: string;
  extensionId: string;
  viewKey: string;
};

async function listPluginViews(
  page: Page,
): Promise<PluginViewSummary[]> {
  return page.evaluate(async () => {
    const views = await window.lvisApi.listPluginUiExtensions();
    return views.map((view) => ({
      pluginId: view.pluginId,
      extensionId: view.extension.id,
      viewKey: `plugin:${view.pluginId}:${view.extension.id}`,
    }));
  });
}

/**
 * Regression guard for the shared plugin bootstrap path:
 * host renderer <webview> mount → main registration/preload/session policy →
 * plugin shell guest webContents creation.
 */
test('embedded plugin view creates a plugin shell webview guest', async ({ app, mainWindow }) => {
  const pluginViews = await listPluginViews(mainWindow);
  const proactiveView = pluginViews.find((view) => view.pluginId === 'work-proactive');

  test.skip(!proactiveView, 'work-proactive sidebar view not available in this build');

  await app.evaluate(({ BrowserWindow }, viewKey) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('lvis:view:activate', { viewKey });
  }, proactiveView!.viewKey);

  await expect(mainWindow.locator('webview')).toHaveCount(1, { timeout: 15_000 });

  const hostWebview = await mainWindow.evaluate(() => {
    const el = document.querySelector('webview');
    return el
      ? {
          src: el.getAttribute('src'),
          preload: el.getAttribute('preload'),
          partition: el.getAttribute('partition'),
        }
      : null;
  });
  expect(hostWebview?.src).toMatch(/plugin-ui-shell\.html$/);
  expect(hostWebview?.preload).toMatch(/plugin-preload\.cjs$/);
  expect(hostWebview?.partition).toMatch(/^persist:plugin:/);

  await expect.poll(
    () =>
      app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some(
          (wc) => wc.getType() === 'webview' && /plugin-ui-shell\.html$/i.test(wc.getURL()),
        ),
      ),
    { timeout: 15_000 },
  ).toBe(true);
});

test('detached plugin view creates a detached host window plus plugin shell guest', async ({ app, mainWindow }) => {
  const pluginViews = await listPluginViews(mainWindow);
  const detachedTarget =
    pluginViews.find((view) => view.pluginId === 'agent-hub')
    ?? pluginViews[0];

  test.skip(!detachedTarget, 'No plugin sidebar views available in this build');

  const detachedWindowPromise = app.waitForEvent('window');
  const openResult = await mainWindow.evaluate(
    async (viewKey) => window.lvisApi.window.openDetached(viewKey),
    detachedTarget!.viewKey,
  );
  expect(openResult.ok).toBe(true);

  const detachedWindow = await detachedWindowPromise;
  await detachedWindow.waitForLoadState('domcontentloaded');
  await expect(detachedWindow.locator('webview')).toHaveCount(1, { timeout: 15_000 });

  await expect.poll(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().includes('#detached/')),
      ),
    { timeout: 15_000 },
  ).toBe(true);
  await expect.poll(
    () =>
      app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some(
          (wc) => wc.getType() === 'webview' && /plugin-ui-shell\.html$/i.test(wc.getURL()),
        ),
      ),
    { timeout: 15_000 },
  ).toBe(true);
});
