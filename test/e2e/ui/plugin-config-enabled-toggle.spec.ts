import { test, expect } from './fixtures';
import { openSettingsWindow, closeSettingsWindow } from './settings-window';

test.use({ seedTogglePlugin: true, seedRepositoryPlugins: false });

/**
 * #1176 — PluginConfigTab active/inactive Switch.
 *
 * Opens the native settings window at the plugin-config tab, selects a LOADED
 * plugin (its toggle is enabled), and toggles its active/inactive Switch.
 * Verifies the selected plugin's own loadStatus badge flips to "비활성"
 * (disabled) and back to "로드됨" (loaded), and that the model-tool visibility
 * note is scoped to that same plugin.
 */
test('plugin-config Switch toggles a loaded plugin active/inactive and back', async ({ app, mainWindow }) => {
  const settings = await openSettingsWindow(app, mainWindow, 'plugin-config');
  try {
    const anyToggle = settings.locator('[data-testid^="plugin-config:enabled-toggle:"]').first();
    const hasToggle = await anyToggle
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    expect(hasToggle, 'Expected at least one runtime-loaded plugin with an active-state toggle').toBe(true);

    const pluginId = 'e2e-toggle-plugin';
    await settings.locator(`[data-testid="plugin-config:row:${pluginId}"]`).click();

    const toggle = settings.locator(`[data-testid="plugin-config:enabled-toggle:${pluginId}"]`);
    const detailStatus = settings.locator(`[data-testid="plugin-config:detail-status:${pluginId}"]`);
    const hiddenNote = settings.locator(`[data-testid="plugin-config:tools-hidden-note:${pluginId}"]`);

    // Initial state: active (loaded), switch checked.
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await expect(detailStatus).toHaveText(/로드됨/);

    // Disable → loadStatus flips to "비활성", tools hidden.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked', { timeout: 15_000 });
    await expect(detailStatus).toHaveText(/비활성/, { timeout: 15_000 });
    await expect(hiddenNote).toBeVisible({ timeout: 15_000 });

    // Re-enable → loadStatus returns to "로드됨", tools re-exposed.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 15_000 });
    await expect(detailStatus).toHaveText(/로드됨/, { timeout: 15_000 });
    await expect(hiddenNote).toHaveCount(0);
  } finally {
    await closeSettingsWindow(app, settings).catch(() => {});
  }
});
