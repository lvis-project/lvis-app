import path from 'node:path';
import fs from 'node:fs';
import { test, expect } from './fixtures.js';
import { scenarios } from './matrix.js';

/**
 * Screenshot capture harness. Data-driven over `scenarios` (matrix.ts) — one
 * Playwright test per key so `--grep <key>` reruns a single screenshot, and
 * `skip` entries surface as Playwright's native "skipped" status (visible in
 * the reporter, not silently absent) instead of being filtered out of the
 * run entirely.
 *
 * Output: test/screenshots/out/<key>.png (gitignored — see README.md).
 */
const OUT_DIR = path.resolve(import.meta.dirname, 'out');

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

for (const [key, entry] of Object.entries(scenarios)) {
  // Skipped scenarios declare a fixture-free test body so a full matrix run
  // doesn't pay for an Electron launch per skip (35 of the 37 entries are
  // skips today — see README.md "Skip list"). Playwright only instantiates
  // fixtures a test's callback actually destructures, so omitting
  // `{ app, mainWindow }` here means `test.skip(reason)` fires with zero
  // Electron startup cost, while still reporting as a native "skipped" test
  // (visible in the list reporter) instead of being silently absent.
  if (entry.skip) {
    const reason = entry.skip;
    test(`capture: ${key}`, () => {
      test.skip(true, reason);
    });
    continue;
  }

  // Scenarios that need real plugin UIs declare `plugins: [...]`. Bind the
  // per-scenario install list to the fixture option via a nested describe so
  // `test.use()` (which must be called at describe/file scope, not inside a
  // test body) applies only to this key's Electron launch.
  test.describe(() => {
    if (entry.plugins && entry.plugins.length > 0) {
      test.use({ installPlugins: entry.plugins });
    }
    if (entry.keepReviewer) {
      test.use({ keepReviewer: true });
    }

    test(`capture: ${key}`, async ({ app, mainWindow }) => {
    if (!entry.steps) {
      throw new Error(`scenario "${key}" has neither "skip" nor "steps" — matrix.ts entry is incomplete`);
    }

    // The settings scenario opens a NATIVE second window (not a view inside
    // mainWindow) — capture it via the window that steps() causes to open,
    // mirroring test/e2e/ui/settings-window.ts's openSettingsWindow helper.
    if (key === '_smoke-settings-llm') {
      const settingsWindowPromise = app.waitForEvent('window', { timeout: 10_000 });
      await entry.steps({ app, page: mainWindow });
      const settingsWindow = await settingsWindowPromise;
      await settingsWindow.waitForLoadState('domcontentloaded');
      await settingsWindow.setViewportSize({ width: 1200, height: 800 });
      await settingsWindow.getByTestId('settings-sidebar-heading').waitFor({
        state: 'visible',
        timeout: 10_000,
      });
      await settingsWindow.addStyleTag({
        content: `*, *::before, *::after { transition-duration: 0ms !important; animation-duration: 0ms !important; caret-color: transparent !important; }`,
      });
      await settingsWindow.screenshot({ path: path.join(OUT_DIR, `${key}.png`) });
      return;
    }

    await entry.steps({ app, page: mainWindow });

    const target = entry.locator ? mainWindow.locator(entry.locator).first() : mainWindow;
    if (entry.locator) {
      await expect(target as ReturnType<typeof mainWindow.locator>).toBeVisible({ timeout: 10_000 });
    }
    await target.screenshot({ path: path.join(OUT_DIR, `${key}.png`) });
    });
  });
}
