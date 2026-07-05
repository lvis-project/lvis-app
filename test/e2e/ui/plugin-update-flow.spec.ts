import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures';
import type { ElectronApplication, Page } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(HERE, '../../..', 'dist/src/main/main.js');

/**
 * #1502 (E5) — one-click plugin update round-trip + partial-failure UX.
 *
 * Verifies the renderer half of the update flow end-to-end without any real
 * network: detect (inject `marketplace:updates-available`) → banner → Update
 * click → install → registry version rises → banner clears; and the
 * partial-failure path where one plugin fails and the succeeded rows drop off
 * while the failed row stays for retry.
 *
 * Mock strategy (network-free): the seeded fixture plugins already live in the
 * registry with real manifests. We override the main-process `lvis:plugins:install`
 * and `lvis:plugins:cards` IPC handlers in-process so the install "succeeds"
 * by recording a bumped version (no catalog fetch, no download, no extract) and
 * the cards handler reports that bumped version — which is exactly what the
 * renderer's post-install `assertInstalledPluginVersion` reconciliation reads.
 * The download/verify/extract internals are explicitly out of E5 scope.
 */

type StubUpdate = {
  pluginId: string;
  pluginName: string;
  installedVersion: string;
  latestVersion: string;
};

/**
 * Replace the main-process install + cards IPC handlers with a network-free
 * stub. `failPluginIds` are the ids whose install rejects (partial-failure
 * coverage); every other install records the requested `expectedVersion` so the
 * subsequent cards read reports the bumped version.
 */
async function installStubInstallHandlers(
  app: ElectronApplication,
  failPluginIds: string[],
): Promise<void> {
  await app.evaluate(({ ipcMain }, failIds) => {
    const failing = new Set(failIds);
    // Records pluginId → bumped version for every successful stub install, so
    // the cards handler can report the risen version the renderer verifies.
    const bumped = new Map<string, string>();

    ipcMain.removeHandler('lvis:plugins:install');
    ipcMain.handle('lvis:plugins:install', (_e: unknown, pluginId: string, options?: unknown) => {
      const expectedVersion =
        typeof options === 'object' && options !== null
          ? (options as { expectedVersion?: unknown }).expectedVersion
          : undefined;
      if (failing.has(pluginId)) {
        throw new Error('e2e-stub: install failed');
      }
      if (typeof expectedVersion === 'string' && expectedVersion.trim()) {
        bumped.set(pluginId, expectedVersion.trim());
      }
      return { pluginId, installed: true };
    });

    // The renderer's post-install `assertInstalledPluginVersion` reads the
    // card list for the requested id + version, so reporting the bumped rows is
    // enough to make the reconciliation pass.
    ipcMain.removeHandler('lvis:plugins:cards');
    ipcMain.handle('lvis:plugins:cards', () =>
      Array.from(bumped, ([id, version]) => ({ id, version })),
    );
  }, failPluginIds);
}

/** Broadcast a `marketplace:updates-available` event to the renderer. */
async function injectUpdatesAvailable(app: ElectronApplication, updates: StubUpdate[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    win?.webContents.send('marketplace:updates-available', payload);
  }, updates);
}

async function waitForBanner(page: Page): Promise<void> {
  await page.locator('[data-testid="marketplace-update-banner"]').waitFor({ state: 'visible', timeout: 10_000 });
}

// The partial-failure assertions read the Korean catalog (mirrors the renderer
// unit suite + the other ko-pinned e2e specs). The English boot path is covered
// by english-default-smoke.spec.ts.
test.use({ seedLocale: 'ko' });

test.skip(!existsSync(MAIN_ENTRY), 'dist/src/main/main.js not built; run bun run build first');

test.describe('plugin update round-trip (E5 #1502)', () => {
  test('detect → banner → Update → install → banner clears on full success', async ({ app, mainWindow }) => {
    await installStubInstallHandlers(app, []);

    const updates: StubUpdate[] = [
      { pluginId: 'meeting', pluginName: 'LVIS Meeting', installedVersion: '1.0.0', latestVersion: '9.9.9' },
    ];
    await injectUpdatesAvailable(app, updates);
    await waitForBanner(mainWindow);

    await expect(mainWindow.getByTestId('marketplace-update-banner')).toContainText('meeting');

    await mainWindow.getByTestId('marketplace-update-action').click();

    // Whole batch succeeded → banner dismisses itself.
    await mainWindow
      .locator('[data-testid="marketplace-update-banner"]')
      .waitFor({ state: 'detached', timeout: 15_000 });

    // Re-broadcasting an empty set (what the host detector does after the
    // version rose) keeps the banner gone — no resurrection race.
    await injectUpdatesAvailable(app, []);
    await expect(mainWindow.locator('[data-testid="marketplace-update-banner"]')).toHaveCount(0);
  });

  test('partial failure keeps the failed row and reports success/failure counts', async ({ app, mainWindow }) => {
    // Two updates; `meeting` succeeds, `local-indexer` fails.
    await installStubInstallHandlers(app, ['local-indexer']);

    const updates: StubUpdate[] = [
      { pluginId: 'meeting', pluginName: 'LVIS Meeting', installedVersion: '1.0.0', latestVersion: '9.9.9' },
      { pluginId: 'local-indexer', pluginName: 'LVIS Indexer', installedVersion: '1.0.0', latestVersion: '9.9.9' },
    ];
    await injectUpdatesAvailable(app, updates);
    await waitForBanner(mainWindow);

    await mainWindow.getByTestId('marketplace-update-action').click();

    // Partial-failure summary renders "성공 1 · 실패 1 (…)".
    const failure = mainWindow.getByTestId('marketplace-update-partial-failure');
    await expect(failure).toBeVisible({ timeout: 15_000 });
    await expect(failure).toContainText('성공 1');
    await expect(failure).toContainText('실패 1');
    await expect(failure).toContainText('local-indexer');

    // The succeeded row (meeting) is pruned; the banner stays for retry.
    await expect(mainWindow.getByTestId('marketplace-update-banner')).toBeVisible();
    await expect(mainWindow.getByTestId('marketplace-update-banner')).not.toContainText('LVIS Meeting');
    await expect(mainWindow.getByTestId('marketplace-update-action')).toContainText('재시도');
  });
});
