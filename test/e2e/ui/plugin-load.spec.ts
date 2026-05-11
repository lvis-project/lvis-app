import { test, expect } from './fixtures';

/**
 * Regression guard: managed plugin UI entries must remain reachable after the
 * main navigation moved to the top action bar + composer plugin grid.
 */
const PLUGIN_VIEWS = [
  { id: 'local-indexer', label: '인덱서' },
  { id: 'meeting', label: '미팅' },
  { id: 'ms-graph', label: '이메일' },
  { id: 'ms-graph', label: '캘린더' },
] as const;

test('plugins with UI extensions appear in the composer plugin grid', async ({ mainWindow }) => {
  const gridButton = mainWindow.locator('[data-testid="plugin-grid-button"]').first();
  await expect(gridButton).toBeVisible({ timeout: 30_000 });
  await gridButton.click();

  const grid = mainWindow.locator('[data-testid="plugin-grid"]').first();
  await expect(grid).toBeVisible({ timeout: 30_000 });

  for (const plugin of PLUGIN_VIEWS) {
    await expect(
      grid.locator(`button:has-text("${plugin.label}")`).first(),
      `Plugin '${plugin.id}' grid entry (label="${plugin.label}") must be visible`,
    ).toBeVisible({ timeout: 30_000 });
  }

  await expect(grid.locator('[data-testid="plugin-cell-add"]').first()).toBeVisible();

  const localIndexerCell = grid.locator('[data-testid="plugin-cell-plugin-local-indexer-main"]').first();
  await expect(localIndexerCell, 'local-indexer grid cell must be clickable after sidebar removal').toBeVisible();
  await localIndexerCell.click();

  await expect(mainWindow.locator('webview').first(), 'plugin grid click should activate an embedded plugin UI').toBeVisible({
    timeout: 30_000,
  });
});
