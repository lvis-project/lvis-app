import { test, expect } from './fixtures.js';
import { openSettingsWindow, closeSettingsWindow } from './settings-window.js';

test.use({ seedRetiredKeywordsPlugin: true, seedRepositoryPlugins: false });

/**
 * `keywords` fed a keyword-to-tool dispatch that was deleted, and the schema
 * property went with it. Bundles installed before that still declare the field,
 * and `additionalProperties: false` turns a dead field into a load failure —
 * which then blocks the update that would have replaced the bundle. The Doctor
 * that failure routes to has no repair for it: it names the field and offers
 * Remove, nothing more. So the field has to be tolerated at load.
 *
 * These run end-to-end rather than against `parsePluginJson` because the claim
 * is about the running app — the manifest has to reach the runtime and the
 * result has to show up in Plugin Settings. Both directions are covered: the
 * retired field loads, and a field no host version ever defined still fails, so
 * the pair distinguishes tolerating one dead name from having stopped checking.
 */
test('an installed plugin carrying the retired keywords field loads', async ({
  app,
  mainWindow,
}) => {
  const settings = await openSettingsWindow(app, mainWindow, 'plugin-config');
  try {
    const pluginId = 'e2e-retired-keywords';
    const row = settings.locator(`[data-testid="plugin-config:row:${pluginId}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    // The active/inactive toggle exists only for a plugin the runtime loaded;
    // a rejected manifest renders a failure card with Doctor/Remove instead.
    await expect(
      settings.locator(`[data-testid="plugin-config:enabled-toggle:${pluginId}"]`),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await closeSettingsWindow(app, settings);
  }
});

test('a plugin carrying a field no host version defined still fails', async ({
  app,
  mainWindow,
}) => {
  const settings = await openSettingsWindow(app, mainWindow, 'plugin-config');
  try {
    const pluginId = 'e2e-unknown-field';

    // Rejected, so no loaded row and no toggle...
    await expect(
      settings.locator(`[data-testid="plugin-config:enabled-toggle:${pluginId}"]`),
    ).toHaveCount(0);

    // ...and the failure is surfaced with the field named, not swallowed.
    await expect(settings.getByText(/bogusRetiredField/).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await closeSettingsWindow(app, settings);
  }
});
