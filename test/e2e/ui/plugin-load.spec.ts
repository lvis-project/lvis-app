import { test, expect } from './fixtures';

/**
 * Regression guard: managed plugin UI entries must remain reachable after the
 * main navigation moved to the top action bar + composer plugin grid.
 */
const PLUGIN_VIEWS = [
  { id: 'local-indexer', label: '로컬 인덱서', testId: 'plugin-cell-plugin-local-indexer-local-indexer-control' },
  { id: 'meeting', label: '미팅', testId: 'plugin-cell-plugin-meeting-meeting-control' },
  { id: 'work-proactive', label: 'Proactive', testId: 'plugin-cell-plugin-work-proactive-detector-control' },
  { id: 'agent-hub', label: '업무 보드', testId: 'plugin-cell-plugin-agent-hub-agent-hub-panel' },
] as const;

test('plugins with UI extensions appear in the composer plugin grid', async ({ mainWindow }) => {
  const gridButton = mainWindow.locator('[data-testid="plugin-grid-button"]').first();
  await expect(gridButton).toBeVisible({ timeout: 30_000 });
  await gridButton.click();

  const grid = mainWindow.locator('[data-testid="plugin-grid"]').first();
  await expect(grid).toBeVisible({ timeout: 30_000 });

  for (const plugin of PLUGIN_VIEWS) {
    await expect(
      grid.locator(`[data-testid="${plugin.testId}"]`).first(),
      `Plugin '${plugin.id}' grid entry (label="${plugin.label}") must be visible`,
    ).toBeVisible({ timeout: 30_000 });
  }

  await expect(grid.locator('[data-testid="plugin-cell-add"]').first()).toBeVisible();

  const localIndexerCell = grid.locator('[data-testid="plugin-cell-plugin-local-indexer-local-indexer-control"]').first();
  await expect(localIndexerCell, 'local-indexer grid cell must be clickable after sidebar removal').toBeVisible();
  await localIndexerCell.click();

  await expect(mainWindow.locator('webview').first(), 'plugin grid click should activate an embedded plugin UI').toBeVisible({
    timeout: 30_000,
  });
});
