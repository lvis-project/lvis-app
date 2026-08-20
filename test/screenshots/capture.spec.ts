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
    // Conversational keys drive a real model turn against the harness's local
    // scripted endpoint (fixtures.ts "Scripted provider"). Binding the options
    // here rather than inside the test body is the same describe-scope
    // requirement `installPlugins` has.
    if (entry.scriptedScript) {
      test.use({ scriptedScript: entry.scriptedScript });
    }
    if (entry.reviewerMode) {
      test.use({ reviewerMode: entry.reviewerMode });
    }
    if (entry.seededCorpus) {
      test.use({ seededCorpus: entry.seededCorpus });
    }
    if (entry.uiLocale) {
      test.use({ uiLocale: entry.uiLocale });
    }

    test(`capture: ${key}`, async ({ app, mainWindow, scriptedProvider }) => {
    if (!entry.steps) {
      throw new Error(`scenario "${key}" has neither "skip" nor "steps" — matrix.ts entry is incomplete`);
    }

    await entry.steps({ app, page: mainWindow });

    const target = entry.locator ? mainWindow.locator(entry.locator).first() : mainWindow;
    if (entry.locator) {
      await expect(target as ReturnType<typeof mainWindow.locator>).toBeVisible({ timeout: 10_000 });
    }
    await target.screenshot({ path: path.join(OUT_DIR, `${key}.png`) });

    // A refused request means the host asked for something the script does not
    // model; the endpoint answers those with an error rather than an improvised
    // completion, so the frame just taken would show the UI's transport-error
    // state. Assert after the capture so the bad artifact is on disk to look at.
    //
    // Unconsumed trailing turns are NOT a failure: a key that captures mid-turn
    // deliberately stops before the tail of its script. The direction that
    // matters — a call the script did not anticipate — is what `violations`
    // records.
    if (scriptedProvider) {
      expect(scriptedProvider.violations, 'scripted provider refused a request').toEqual([]);
    }
    });
  });
}
