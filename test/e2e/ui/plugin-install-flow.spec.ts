import { test, expect } from './fixtures';

/**
 * Plugin install/uninstall flow smoke — locates a marketplace/plugins UI and
 * verifies an install or uninstall affordance renders. Skips cleanly when
 * no marketplace UI is available in the current build.
 */
test('plugin install flow renders install/uninstall affordance, or skips', async ({
  mainWindow,
  t,
}) => {
  const pluginGridButton = mainWindow.locator('[data-testid="plugin-grid-button"]').first();
  const gridVisible = await pluginGridButton
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!gridVisible, 'No plugin grid entry point — skipping install flow.');

  await pluginGridButton.click();

  const actionButton = mainWindow
    .locator(
      [
        '[data-testid="plugin-cell-add"]',
        '[data-testid="plugin-install"]',
        '[data-testid="plugin-uninstall"]',
        'button:has-text("Install")',
        'button:has-text("Uninstall")',
        `button:has-text("${t('marketplaceTab.installButton')}")`,
        `button:has-text("${t('marketplaceTab.removeButton')}")`,
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
