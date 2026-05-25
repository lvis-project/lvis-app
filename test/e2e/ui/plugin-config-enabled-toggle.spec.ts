import { test, expect } from './fixtures';
import { openSettingsWindow, closeSettingsWindow } from './settings-window';

/**
 * #1176 — PluginConfigTab active/inactive Switch.
 *
 * Opens the native settings window at the plugin-config tab, selects a LOADED
 * plugin (its toggle is enabled), and toggles its active/inactive Switch.
 * Verifies the card's loadStatus badge flips to "비활성" (disabled) and back to
 * "로드됨" (loaded) — the renderer-visible signal that the plugin's tools are
 * hidden / re-exposed. Skips cleanly when no loaded plugin is seeded (e.g. all
 * seeded plugins are in a preparing/failed runtime state) or none are seeded.
 */
test('plugin-config Switch toggles a loaded plugin active/inactive and back', async ({ app, mainWindow }) => {
  const settings = await openSettingsWindow(app, mainWindow, 'plugin-config');
  try {
    const anyToggle = settings.locator('[data-testid^="plugin-config:enabled-toggle:"]').first();
    const hasToggle = await anyToggle
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasToggle, 'No installed plugin with an enable toggle — skipping.');

    // Walk the plugin list and select the first plugin whose detail toggle is
    // ENABLED (loaded). Preparing/failed plugins render a disabled toggle and
    // cannot be toggled — skip past them. The plugin list is a column of
    // <button> rows showing name + status badge.
    const rows = settings.locator('button:has(span)').filter({ hasText: /.+/ });
    const rowCount = await rows.count();

    let pluginId = '';
    for (let i = 0; i < rowCount && !pluginId; i += 1) {
      await rows.nth(i).click().catch(() => {});
      const toggle = settings.locator('[data-testid^="plugin-config:enabled-toggle:"]').first();
      const visible = await toggle
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (!visible) continue;
      const isDisabled = await toggle.isDisabled().catch(() => true);
      if (!isDisabled) {
        pluginId = (await toggle.getAttribute('data-testid'))?.replace(
          'plugin-config:enabled-toggle:',
          '',
        ) ?? '';
      }
    }

    test.skip(pluginId.length === 0, 'No loaded plugin available to toggle in this environment — skipping.');

    const toggle = settings.locator(`[data-testid="plugin-config:enabled-toggle:${pluginId}"]`);
    const disabledBadge = settings.getByText('비활성', { exact: true }).first();
    const loadedBadge = settings.getByText('로드됨', { exact: true }).first();

    // Initial state: active (loaded), switch checked.
    await expect(toggle).toHaveAttribute('data-state', 'checked');

    // Disable → loadStatus flips to "비활성", tools hidden.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'unchecked', { timeout: 15_000 });
    await expect(disabledBadge).toBeVisible({ timeout: 15_000 });

    // Re-enable → loadStatus returns to "로드됨", tools re-exposed.
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-state', 'checked', { timeout: 15_000 });
    await expect(loadedBadge).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeSettingsWindow(app, settings).catch(() => {});
  }
});
