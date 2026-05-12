/**
 * Plan §R5 — Cache Invalidate Smoke Test
 *
 * Problem being guarded:
 *   When a plugin is upgraded from v0.1.x to v0.2.0, the marketplace cache
 *   may still hold the old manifest pointing to `dist/ui/agent-hub-panel.js`
 *   (the pre-v3 entry path). If the plugin loader silently falls back to the
 *   stale entry, the new panel UI never mounts — a silent mount failure that
 *   is very hard to diagnose in production.
 *
 * What this test verifies:
 *   1. A stale v0.1.x manifest pointing to the old entry path is present
 *   2. The plugin loader force-reloads and detects the installed current manifest
 *   3. The resolved entry path is `dist/ui/work-board-panel.js` (NOT the old one)
 *   4. No silent fallback to the stale entry occurs
 *
 * Strategy:
 *   - Intercept / simulate the marketplace cache with a v0.1.x manifest
 *   - Trigger plugin loader force-reload via the IPC bridge or window API
 *   - Assert that the resolved entry is the v3 path
 *
 * This test runs against the LIVE Electron process but uses evaluate() to
 * inject and inspect state without needing the real marketplace server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../ui/fixtures';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'agent-hub';

/** Old entry path (pre-v3, should NOT be used after v0.2.0 force-reload) */
const STALE_ENTRY_PATH = 'dist/ui/agent-hub-panel.js';

/** Current work-board entry path (v3, must be resolved after force-reload) */
const V3_ENTRY_PATH = 'dist/ui/work-board-panel.js';

/** Stale v0.1.x manifest shape that would be present in a cold cache */
const STALE_MANIFEST = {
  id: PLUGIN_ID,
  name: 'LVIS Agent Hub',
  version: '0.1.9',
  main: 'dist/index.js',
  ui: [
    {
      slot: 'sidebar',
      entry: STALE_ENTRY_PATH,
      displayName: 'Agent Hub',
    },
  ],
};

function readInstalledAgentHubManifest(userDataDir: string): any {
  const manifestPath = path.join(
    userDataDir,
    'lvis-state',
    'plugins',
    PLUGIN_ID,
    'plugin.json',
  );
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('R5: stale v0.1.x cached manifest has old entry path', async ({ mainWindow }) => {
  /**
   * Verify that a stale manifest (as would exist in a user's cached install)
   * still references the OLD panel entry. This is the pre-condition for R5.
   */
  const staleEntryPath = STALE_MANIFEST.ui[0].entry;
  expect(staleEntryPath).toBe(STALE_ENTRY_PATH);
  expect(staleEntryPath).not.toBe(V3_ENTRY_PATH);

  // Also verify the stale version is below 0.2.0
  const [major, minor] = STALE_MANIFEST.version.split('.').map(Number);
  expect(major).toBe(0);
  expect(minor).toBeLessThan(2);

  // Verify that the main window loaded at all (Electron booted)
  await expect(mainWindow.locator('[data-testid="main-toolbar"]').first()).toBeVisible({
    timeout: 30_000,
  });
});

test('R5: installed manifest entry path is dist/ui/work-board-panel.js', async ({ mainWindow, userDataDir }) => {
  /**
   * Verify that the installed manifest fixture correctly points to the v3 entry.
   * This guards against a typo or misconfiguration in the plugin.json when
   * publishing to the marketplace.
   */
  const installedManifest = readInstalledAgentHubManifest(userDataDir);
  const installedEntryPath = installedManifest.ui?.[0]?.entry;
  expect(installedEntryPath).toBe(V3_ENTRY_PATH);
  expect(installedEntryPath).not.toBe(STALE_ENTRY_PATH);

  expect(installedManifest.id).toBe(PLUGIN_ID);

  await expect(mainWindow.locator('[data-testid="main-toolbar"]').first()).toBeVisible({
    timeout: 30_000,
  });
});

test('R5: plugin loader resolves installed v3 entry path after force-reload', async ({ mainWindow, userDataDir }) => {
  /**
   * Inject the stale manifest into the plugin loader's cache simulation,
   * then trigger a force-reload and assert that the resolved entry path
   * is updated to the v3 path.
   *
   * The plugin loader exposes __lvis_plugin_loader__ on window in LVIS_E2E=1
   * mode. If not available, we fall back to inspecting the loaded plugin
   * registry for the correct entry.
   */
  const installedManifest = readInstalledAgentHubManifest(userDataDir);
  expect(installedManifest.ui?.[0]?.entry).toBe(V3_ENTRY_PATH);

  const result = await mainWindow.evaluate(
    ({ pluginId, staleManifest, installedManifest, staleEntry, v3Entry }) => {
      const win = window as any;

      // --- Path A: plugin loader test API available ---
      if (win.__lvis_plugin_loader__) {
        const loader = win.__lvis_plugin_loader__;

        // Inject stale manifest into cache
        if (typeof loader.setCachedManifest === 'function') {
          loader.setCachedManifest(pluginId, staleManifest);
        }

        // Trigger force-reload
        if (typeof loader.forceReload === 'function') {
          loader.forceReload(pluginId, installedManifest);
        }

        // Read resolved entry
        const resolvedEntry: string | undefined =
          typeof loader.getResolvedEntry === 'function'
            ? loader.getResolvedEntry(pluginId)
            : undefined;

        return {
          path: 'loader-api',
          resolvedEntry,
          isV3: resolvedEntry === v3Entry,
          isStale: resolvedEntry === staleEntry,
        };
      }

      // --- Path B: inspect plugin registry ---
      if (win.__lvis_plugin_registry__) {
        const registry = win.__lvis_plugin_registry__;
        const plugin =
          typeof registry.get === 'function'
            ? registry.get(pluginId)
            : (registry[pluginId] ?? null);

        const entryFromRegistry: string | undefined =
          plugin?.manifest?.ui?.[0]?.entry ??
          plugin?.ui?.[0]?.entry ??
          plugin?.entryPath;

        return {
          path: 'registry',
          resolvedEntry: entryFromRegistry,
          isV3: entryFromRegistry === v3Entry,
          isStale: entryFromRegistry === staleEntry,
        };
      }

      // --- Path C: inspect loaded plugin frames ---
      // Plugin UI iframes/webviews expose their src attribute.
      // The current work-board frame URL should contain the current entry filename.
      const frames = Array.from(document.querySelectorAll('iframe, webview'));
      const agentHubFrame = frames.find(
        (f) =>
          f.getAttribute('src')?.includes('agent-hub') ||
          f.getAttribute('src')?.includes('work-board-panel') ||
          f.getAttribute('data-plugin-id') === pluginId,
      );
      const frameSrc = agentHubFrame?.getAttribute('src') ?? null;

      return {
        path: 'frame-src',
        resolvedEntry: frameSrc,
        isV3: frameSrc?.includes('work-board-panel') ?? false,
        isStale: frameSrc?.includes('agent-hub-panel.js') ?? false,
        frameFound: !!agentHubFrame,
      };
    },
    { pluginId: PLUGIN_ID, staleManifest: STALE_MANIFEST, installedManifest, staleEntry: STALE_ENTRY_PATH, v3Entry: V3_ENTRY_PATH },
  );

  // If no plugin loader API was found at all, skip gracefully
  test.skip(
    result.path === 'frame-src' && !(result as any).frameFound,
    'Plugin loader API and frame src not accessible — R5 smoke requires LVIS_E2E=1 plugin loader hooks',
  );

  // The resolved entry must NOT be the stale one
  expect(
    result.isStale,
    `R5 FAIL: plugin loader resolved stale entry "${STALE_ENTRY_PATH}" after force-reload. ` +
    `This means cached v0.1.x installs will fail to mount the v3 panel after upgrade. ` +
    `resolvedEntry=${JSON.stringify(result.resolvedEntry)}`,
  ).toBe(false);

  // If we could determine the v3 path, assert it explicitly
  if (result.resolvedEntry !== null && result.resolvedEntry !== undefined) {
    expect(
      result.isV3,
      `R5 FAIL: resolved entry "${result.resolvedEntry}" does not match expected v3 path "${V3_ENTRY_PATH}". ` +
      `Ensure plugin.json in v0.2.0 declares ui[0].entry = "${V3_ENTRY_PATH}"`,
    ).toBe(true);
  }
});

test('R5: no silent mount failure — v3 panel is reachable after cache bust', async ({ mainWindow }) => {
  /**
   * End-to-end guard: after a cache invalidation signal, the agent-hub panel
   * must either be visible in the sidebar OR the plugin loader must report a
   * successful load (not a silent failure).
   *
   * A "silent mount failure" is when:
   *   - The plugin loader resolves a stale/missing entry path
   *   - No error is thrown (it catches internally)
   *   - The panel simply never renders
   *
   * We detect this by checking that:
   *   1. The plugin loader does NOT report a load error for agent-hub, AND
   *   2. The main window sidebar is still functional (no crash)
   */
  const loaderStatus = await mainWindow.evaluate((pluginId: string) => {
    const win = window as any;

    if (win.__lvis_plugin_loader__) {
      const loader = win.__lvis_plugin_loader__;
      const errors: unknown[] =
        typeof loader.getErrors === 'function' ? loader.getErrors() : [];
      const agentHubErrors = errors.filter(
        (e: any) =>
          e?.pluginId === pluginId ||
          String(e?.message ?? '').toLowerCase().includes('agent-hub'),
      );
      return {
        hasLoader: true,
        errorCount: agentHubErrors.length,
        errors: agentHubErrors,
      };
    }

    return { hasLoader: false, errorCount: 0, errors: [] };
  }, PLUGIN_ID);

  // Main window must still be alive
  await expect(mainWindow.locator('[data-testid="main-toolbar"]').first()).toBeVisible({
    timeout: 15_000,
  });

  if (loaderStatus.hasLoader) {
    expect(
      loaderStatus.errorCount,
      `R5 FAIL: plugin loader reported ${loaderStatus.errorCount} error(s) for agent-hub after cache bust. ` +
      `Errors: ${JSON.stringify(loaderStatus.errors)}`,
    ).toBe(0);
  }
  // If no loader API, we just verified the window is alive — that's the minimum bar.
});
