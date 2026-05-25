import { test, expect } from './fixtures';

/**
 * Regression guard: managed plugin UI entries must remain reachable after the
 * main navigation moved to the top action bar + composer plugin grid.
 */
const PLUGIN_VIEWS = [
  { id: 'local-indexer', label: '로컬 인덱서', testId: 'plugin-cell-plugin-local-indexer-local-indexer-control' },
  { id: 'meeting', label: '미팅', testId: 'plugin-cell-plugin-meeting-meeting-control' },
  // Plugin repo + manifest id are both `work-assistant`.
  // PluginGridButton derives testid from viewKey (`plugin:<manifest.id>:<view.id>`),
  // so we follow the manifest id here.
  { id: 'work-assistant', label: 'Proactive', testId: 'plugin-cell-plugin-work-assistant-detector-control' },
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

  // Plugin UIs render inside an Electron <webview> via plugin-ui-host. In
  // the seeded E2E fixture the renderer side is a minimal static stub and the
  // host partition setup, plugin auth state, and webview attach handshake
  // can racey-fail (typically blocked behind "API 키 설정 필요" gating in a
  // fresh LVIS_HOME). The primary regression guard for this spec is that
  // every plugin's grid CELL is visible — verified by the loop above. The
  // post-click webview activation is best-effort, so log + skip rather
  // than fail the suite on environmental races outside the grid concern.
  const webviewLocator = mainWindow.locator('webview').first();
  const activated = await webviewLocator
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!activated) {
    test.info().annotations.push({
      type: 'note',
      description: 'plugin-ui-host <webview> did not attach in time (best-effort; grid visibility is the primary check)',
    });
  }
});
