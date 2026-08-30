import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

/**
 * A real turn, driven through the real app.
 *
 * The adapter smoke suite (`test/smoke/live-model.smoke.test.ts`) proves the
 * provider wire in isolation. It cannot prove the app: settings resolution, key
 * lookup, the engine loop, tool exposure, and the permission path all sit
 * between the composer and that adapter, and every one of them is mocked or
 * absent in the offline suites. This drives the shipped main process over CDP
 * and asserts what a user would actually see.
 *
 * Opt-in: skipped unless `LVIS_SMOKE_OPENROUTER_KEY` is exported, which is also
 * what makes the fixture swap the fake key for a real one. Offline runs and CI
 * are untouched.
 */

const liveKey = process.env.LVIS_SMOKE_OPENROUTER_KEY?.trim();

test.describe('live model turn', () => {
  test.skip(!liveKey, 'set LVIS_SMOKE_OPENROUTER_KEY to run a real turn');
  test.use({ seedRepositoryPlugins: false });

  test('answers a prompt end to end', async ({ mainWindow }) => {
    const composer = mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea)).first();
    await expect(composer).toBeVisible({ timeout: 60_000 });

    // A composer that is present but disabled is the failure this catches:
    // it means the host did not resolve the seeded key, and no amount of
    // typing would ever produce a turn.
    await expect(composer).toBeEnabled({ timeout: 60_000 });

    await composer.fill('Reply with exactly one word: pong');
    await mainWindow.locator('[data-testid="composer-send-button"]').first().click();

    const assistant = mainWindow.locator('[data-testid="assistant-message-body"]').first();
    await expect(assistant).toBeVisible({ timeout: 180_000 });

    // Assert the model's actual answer, not merely that *something* rendered.
    // A provider error renders into this same node, so "visible and non-empty"
    // passes on a turn that failed — an assertion that cannot fail is worth
    // nothing here.
    await expect(assistant).toContainText(/pong/i, { timeout: 180_000 });
  });
});
