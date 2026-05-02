import { test, expect } from './fixtures';

/**
 * Regression guard: managed plugins must load successfully during E2E boot.
 *
 * This test was added after a regression where plugins were silently rejected
 * due to a missing LVIS_DEV bypass in the path-traversal security check
 * (resolvePluginEntryPath / resolveEntryPath in src/plugins/runtime.ts).
 *
 * When a plugin fails to load, its corresponding toolbar tab and/or sidebar
 * marketplace card disappears — this test catches that immediately.
 *
 * Plugin UI tab mapping (from each plugin.json `ui[].displayName`):
 *   local-indexer → "인덱서"
 *   meeting   → "미팅"
 *   ms-graph  → "이메일" + "캘린더" (single plugin provides two sidebar UIs)
 */

/**
 * Plugins that register a sidebar UI extension produce a TabsTrigger in
 * MainToolbar with their displayName as the label. The ms-graph plugin
 * registers two extensions (email + calendar) — both must appear.
 */
const PLUGIN_TABS = [
  { id: 'local-indexer', label: '인덱서' },
  { id: 'meeting', label: '미팅' },
  { id: 'ms-graph', label: '이메일' },
  { id: 'ms-graph', label: '캘린더' },
] as const;

/**
 * All 3 bundled plugins should appear in the sidebar marketplace, regardless
 * of whether they have a UI extension.
 */
const ALL_PLUGIN_NAMES = [
  'LVIS PageIndex',
  'LVIS Meeting',
  'LVIS Microsoft 365',
] as const;

test('plugins with UI extensions appear as toolbar tabs', async ({ mainWindow }) => {
  // The mainWindow fixture already waits for [role="tablist"] to appear.
  // Plugin tabs are added dynamically after pluginViews IPC resolves,
  // so we need an additional wait after the static toolbar is visible.
  const tabsList = mainWindow.locator('[role="tablist"]').first();
  await tabsList.waitFor({ state: 'visible', timeout: 15_000 });

  for (const plugin of PLUGIN_TABS) {
    // Plugin tabs use Radix TabsTrigger which renders as button[role="tab"]
    const tab = mainWindow.locator(
      [
        `button[role="tab"]:has-text("${plugin.label}")`,
        `[role="tab"]:has-text("${plugin.label}")`,
      ].join(', '),
    ).first();

    await expect(
      tab,
      `Plugin '${plugin.id}' toolbar tab (label="${plugin.label}") must be visible`,
    ).toBeVisible({ timeout: 30_000 });
  }
});

test('all 3 bundled plugins listed in sidebar marketplace', async ({ mainWindow }) => {
  // The sidebar <aside> is always rendered (not conditionally mounted).
  const sidebar = mainWindow.locator('aside').first();
  await sidebar.waitFor({ state: 'visible', timeout: 15_000 });

  for (const pluginName of ALL_PLUGIN_NAMES) {
    // Each marketplace card contains the plugin name as a visible text node.
    const card = sidebar.locator(`text=${pluginName}`).first();

    await expect(
      card,
      `Plugin '${pluginName}' must appear in sidebar marketplace`,
    ).toBeVisible({ timeout: 30_000 });
  }
});

test('managed plugins show installed status in sidebar', async ({ mainWindow }) => {
  const sidebar = mainWindow.locator('aside').first();
  await sidebar.waitFor({ state: 'visible', timeout: 15_000 });

  // Bundled plugins should all show "설치됨" badge.
  const installedBadges = sidebar.locator('text=설치됨');

  // 3 bundled plugins should be installed (local-indexer / meeting / ms-graph).
  await expect(installedBadges).toHaveCount(3, { timeout: 30_000 });
});
