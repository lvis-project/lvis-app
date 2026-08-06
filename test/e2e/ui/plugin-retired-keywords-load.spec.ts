import { test, expect } from './fixtures.js';
import { openSettingsWindow, closeSettingsWindow } from './settings-window.js';

test.use({ seedRetiredKeywordsPlugin: true, seedRepositoryPlugins: false });

/**
 * `keywords` fed a keyword-to-tool dispatch that was deleted, and the schema
 * property went with it. Bundles installed before that still declare the field,
 * and `additionalProperties: false` turns a dead field into a load failure.
 *
 * That failure is normally self-healing: the boot managed sync commits a newer
 * bundle before the runtime loads, and the Doctor classifies
 * `manifest-validation-error` as reinstall-fixable and auto-installs the latest
 * marketplace version (`src/shared/plugin-install-failure.ts`). Both repairs
 * need the marketplace to serve a clean version of that plugin. When it cannot
 * — offline boot, or a plugin published only to a network the user is not on —
 * the reinstall fails and the documented fallback is Remove, which
 * `deployment-guard.ts` refuses for `installSource: "admin"`. That plugin is
 * then neither repairable nor removable, so the field has to be tolerated.
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
