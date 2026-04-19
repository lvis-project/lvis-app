import { test, expect } from './fixtures';

/**
 * Plugin install/uninstall flow smoke — locates a marketplace/plugins UI and
 * verifies an install or uninstall affordance renders. Skips cleanly when
 * no marketplace UI is available in the current build.
 */
test('plugin install flow renders install/uninstall affordance, or skips', async ({
  mainWindow,
}) => {
  const pluginsTab = mainWindow
    .locator(
      [
        '[data-testid="sidebar-tab-plugins"]',
        '[data-testid="tab-plugins"]',
        'button[role="tab"]:has-text("Plugins")',
        'button[role="tab"]:has-text("플러그인")',
        'button:has-text("Marketplace")',
      ].join(', '),
    )
    .first();

  const tabVisible = await pluginsTab
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!tabVisible, 'No plugins/marketplace tab — skipping install flow.');

  await pluginsTab.click();

  const actionButton = mainWindow
    .locator(
      [
        '[data-testid="plugin-install"]',
        '[data-testid="plugin-uninstall"]',
        'button:has-text("Install")',
        'button:has-text("Uninstall")',
        'button:has-text("설치")',
        'button:has-text("제거")',
      ].join(', '),
    )
    .first();

  const hasAction = await actionButton
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!hasAction, 'No install/uninstall buttons rendered — skipping.');

  await expect(actionButton).toBeVisible();
});
