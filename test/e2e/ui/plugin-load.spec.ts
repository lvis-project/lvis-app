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
  // Wait for the toolbar TabsList to render (it contains static tabs like 홈, 태스크, …).
  // Plugin tabs are appended dynamically after pluginViews are fetched from IPC.
  const tabsList = mainWindow.locator('[role="tablist"]').first();
  await tabsList.waitFor({ state: 'attached', timeout: 15_000 });

  for (const plugin of PLUGIN_TABS) {
    // Match the exact selector pattern used in sidebar-tabs.spec.ts:
    //   button[role="tab"]:has-text("label")
    const tab = mainWindow.locator(
      [
        `button[role="tab"]:has-text("${plugin.label}")`,
        `button:has-text("${plugin.label}")`,
      ].join(', '),
    ).first();

    await expect(
      tab,
      `Plugin '${plugin.id}' toolbar tab (label="${plugin.label}") must be visible`,
    ).toBeVisible({ timeout: 10_000 });
  }
});

test('all 4 managed plugins listed in sidebar marketplace', async ({ mainWindow }) => {
  // The sidebar is an <aside> rendered by Sidebar.tsx.
  const sidebar = mainWindow.locator('aside').first();
  await sidebar.waitFor({ state: 'attached', timeout: 15_000 });

  for (const pluginName of ALL_PLUGIN_NAMES) {
    // Each marketplace card contains the plugin name as a text node
    // inside a <div class="font-medium ..."> element.
    const card = sidebar.locator(`text=${pluginName}`).first();

    await expect(
      card,
      `Plugin '${pluginName}' must appear in sidebar marketplace`,
    ).toBeVisible({ timeout: 10_000 });
  }
});

test('managed plugins show installed status in sidebar', async ({ mainWindow }) => {
  const sidebar = mainWindow.locator('aside').first();
  await sidebar.waitFor({ state: 'attached', timeout: 15_000 });

  // Managed plugins should all show "설치됨" badge. Count badges matching.
  // Each installed plugin card contains a Badge with text "설치됨".
  const installedBadges = sidebar.locator('text=설치됨');

  // At least 4 managed plugins should be installed.
  await expect(installedBadges).toHaveCount(4, { timeout: 10_000 });
});
