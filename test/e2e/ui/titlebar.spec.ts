import { test, expect } from './fixtures';

/**
 * Custom titlebar E2E tests.
 *
 * On macOS: a drag-only band renders (data-testid="custom-titlebar-darwin"),
 *           no minimize/maximize/close buttons are present.
 * On Win/Linux: the full control bar renders (data-testid="custom-titlebar")
 *               with minimize, maximize, and close buttons.
 *
 * Platform-specific button assertions are skipped in headless CI when the
 * platform cannot be determined from the rendered DOM.
 */

test('CustomTitleBar renders on all platforms', async ({ mainWindow }) => {
  // At least one of the two titlebar variants must be mounted.
  const darwinBar = mainWindow.locator('[data-testid="custom-titlebar-darwin"]');
  const winBar = mainWindow.locator('[data-testid="custom-titlebar"]');

  const hasDarwin = await darwinBar.count();
  const hasWin = await winBar.count();

  expect(hasDarwin + hasWin).toBeGreaterThanOrEqual(1);
});

test('macOS titlebar has no window-control buttons', async ({ mainWindow }) => {
  const darwinBar = mainWindow.locator('[data-testid="custom-titlebar-darwin"]');
  const isDarwin = (await darwinBar.count()) > 0;
  test.skip(!isDarwin, 'macOS-only assertion — skipping on Win/Linux');

  // No minimize/maximize/close buttons on macOS
  await expect(mainWindow.locator('[data-testid="titlebar-minimize"]')).toHaveCount(0);
  await expect(mainWindow.locator('[data-testid="titlebar-maximize"]')).toHaveCount(0);
  await expect(mainWindow.locator('[data-testid="titlebar-close"]')).toHaveCount(0);
});

test('Win/Linux titlebar exposes minimize, maximize, and close buttons', async ({ mainWindow }) => {
  const winBar = mainWindow.locator('[data-testid="custom-titlebar"]');
  const isWinLinux = (await winBar.count()) > 0;
  test.skip(!isWinLinux, 'Win/Linux-only assertion — skipping on macOS');

  await expect(mainWindow.locator('[data-testid="titlebar-minimize"]')).toBeVisible();
  await expect(mainWindow.locator('[data-testid="titlebar-maximize"]')).toBeVisible();
  await expect(mainWindow.locator('[data-testid="titlebar-close"]')).toBeVisible();
});
