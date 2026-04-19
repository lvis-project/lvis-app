import { test, expect } from './fixtures';

test('app launches and main window is visible', async ({ app, mainWindow }) => {
  const title = await mainWindow.title();
  expect(title.length).toBeGreaterThan(0);

  const isVisible = await mainWindow.evaluate(() => document.visibilityState !== 'hidden');
  expect(isVisible).toBe(true);

  // Root React container must be present per src/index.html.
  const hasRoot = await mainWindow.locator('#root').count();
  expect(hasRoot).toBe(1);

  const windows = app.windows();
  expect(windows.length).toBeGreaterThanOrEqual(1);
});
