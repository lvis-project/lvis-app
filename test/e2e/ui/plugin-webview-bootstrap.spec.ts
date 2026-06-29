import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

type PluginViewSummary = {
  pluginId: string;
  extensionId: string;
  kind: string;
  viewKey: string;
};

async function listPluginViews(
  page: Page,
): Promise<PluginViewSummary[]> {
  return page.evaluate(async () => {
    const views = await window.lvisApi.listPluginUiExtensions();
    return views
      .filter((view) => view.extension.slot === 'sidebar')
      .map((view) => ({
        pluginId: view.pluginId,
        extensionId: view.extension.id,
        kind: view.extension.kind,
        viewKey: `plugin:${view.pluginId}:${view.extension.id}`,
      }));
  });
}

async function readWebviewHostChrome(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const webview = document.querySelector('webview');
    const classes: string[] = [];
    let node = webview?.parentElement ?? null;
    for (let depth = 0; node && depth < 5; depth += 1) {
      if (node.className) classes.push(String(node.className));
      node = node.parentElement;
    }
    return classes;
  });
}

/**
 * Regression guard for the shared plugin bootstrap path:
 * host renderer <webview> mount → main registration/preload/session policy →
 * plugin shell guest webContents creation.
 */
test('embedded plugin view creates a plugin shell webview guest', async ({ app, mainWindow }) => {
  const pluginViews = await listPluginViews(mainWindow);
  // Any sidebar view can render inline — whether a view detaches is decided by
  // the app's mode (appMode), not the plugin, so there is no per-view embedded
  // flag to filter on. Work mode (the inline path) activates it in place.
  const embeddedView = pluginViews.find((view) => view.kind === 'embedded-module');

  test.skip(!embeddedView, 'No plugin view available in this build');

  await app.evaluate(({ BrowserWindow }, viewKey) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.send('lvis:view:activate', { viewKey });
  }, embeddedView!.viewKey);

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

  const hostChrome = await readWebviewHostChrome(mainWindow);
  expect(hostChrome.join(' ')).not.toContain('bg-card');
  expect(hostChrome.join(' ')).not.toContain('text-card-foreground');
  expect(hostChrome.join(' ')).not.toContain('border');

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

test('embedded plugin views share the flat inline host chrome', async ({ app, mainWindow }) => {
  const pluginViews = (await listPluginViews(mainWindow)).filter((view) => view.kind === 'embedded-module');

  test.skip(pluginViews.length === 0, 'No embedded plugin view available in this build');

  for (const pluginView of pluginViews) {
    await app.evaluate(({ BrowserWindow }, viewKey) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.send('lvis:view:activate', { viewKey });
    }, pluginView.viewKey);

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

    const hostChrome = await readWebviewHostChrome(mainWindow);
    expect(hostChrome.join(' '), pluginView.viewKey).not.toContain('bg-card');
    expect(hostChrome.join(' '), pluginView.viewKey).not.toContain('text-card-foreground');
    expect(hostChrome.join(' '), pluginView.viewKey).not.toContain('border');
  }
});

test('detached plugin view creates a detached host window plus plugin shell guest', async ({ app, mainWindow }) => {
  const pluginViews = await listPluginViews(mainWindow);
  // Detachment is driven by the app's mode (appMode === 'chat'), not a plugin
  // flag; the host openDetached IPC is the path under test, so any sidebar view
  // is a valid target.
  const detachedTarget = pluginViews.find((view) => view.kind === 'embedded-module');

  test.skip(!detachedTarget, 'No plugin view available in this build');

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
