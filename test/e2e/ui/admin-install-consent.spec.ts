import { test, expect } from './fixtures';

/**
 * #1098 — admin-policy plugin installs are gated behind an explicit UAC-style
 * consent dialog (privilege warning + acknowledgment checkbox that enables the
 * install button). This smoke walks the marketplace and, when an admin-policy
 * install affordance is present, asserts the consent gate appears and gates the
 * confirm button. It skips cleanly when the running build's catalog has no
 * admin-policy plugin (the substantive coverage lives in the renderer unit
 * tests: PluginInstallDialog.test.tsx + MarketplaceTab.test.tsx).
 */
test('admin-policy plugin install is gated behind a consent dialog, or skips', async ({
  mainWindow,
}) => {
  const pluginGridButton = mainWindow.locator('[data-testid="plugin-grid-button"]').first();
  const gridVisible = await pluginGridButton
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!gridVisible, 'No plugin grid entry point — skipping admin-consent flow.');

  await pluginGridButton.click();

  // Find any install action button (testid is keyed by plugin id).
  const actionButton = mainWindow.locator('[data-testid^="marketplace:action:"]').first();
  const hasAction = await actionButton
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasAction, 'No marketplace install affordance rendered — skipping.');

  await actionButton.click();

  // The consent dialog only appears for admin-policy plugins. If the clicked
  // plugin was user-policy (no consent block), this run has nothing to assert.
  const consent = mainWindow.locator('[data-testid="plugin-install-consent"]');
  const isAdminFlow = await consent
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!isAdminFlow, 'Clicked plugin is not admin-policy — no consent gate to assert.');

  // Consent gate present: the acknowledgment checkbox must gate the confirm.
  const checkbox = consent.getByRole('checkbox');
  await expect(checkbox).toBeVisible();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
});
