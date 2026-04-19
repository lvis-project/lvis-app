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
 *   pageindex → "인덱서"
 *   meeting   → "미팅"
 *   email     → "이메일"
 *   calendar  → (no UI extension — verified via sidebar marketplace only)
 */

/**
 * Plugins that register a sidebar UI extension produce a TabsTrigger in
 * MainToolbar with their displayName as the label.
 */
const PLUGIN_TABS = [
  { id: 'pageindex', label: '인덱서' },
  { id: 'meeting', label: '미팅' },
  { id: 'email', label: '이메일' },
] as const;

/**
 * All 4 managed plugins should appear in the sidebar marketplace, regardless
 * of whether they have a UI extension.
 */
const ALL_PLUGIN_NAMES = [
  'LVIS PageIndex',
  'LVIS Meeting',
  'LVIS Email',
  'LVIS Calendar',
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

test('all 4 managed plugins listed in sidebar marketplace', async ({ mainWindow }) => {
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

  // Managed plugins should all show "설치됨" badge.
  const installedBadges = sidebar.locator('text=설치됨');

  // At least 4 managed plugins should be installed.
  await expect(installedBadges).toHaveCount(4, { timeout: 30_000 });
});
