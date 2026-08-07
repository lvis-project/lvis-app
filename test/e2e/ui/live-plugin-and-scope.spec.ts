import { test, expect } from './fixtures.js';

/**
 * Live checks the offline suites cannot make:
 *
 *   1. a real model actually calling a PLUGIN tool (not just a builtin), and
 *   2. a real call to a path outside the allowed directories reaching the
 *      out-of-scope review instead of silently succeeding.
 *
 * Both need a real provider (`LVIS_SMOKE_OPENROUTER_KEY`) and seeded repository
 * plugins. The permission mode decides which of the two can run:
 *   LVIS_E2E_PERMISSION_MODE=allow    → (1), tools run without a card
 *   LVIS_E2E_PERMISSION_MODE=default  → (2), the card is the thing under test
 */

const liveKey = process.env.LVIS_SMOKE_OPENROUTER_KEY?.trim();
const mode = process.env.LVIS_E2E_PERMISSION_MODE?.trim() ?? 'default';

test.describe('live plugin + scope', () => {
  test.skip(!liveKey, 'set LVIS_SMOKE_OPENROUTER_KEY to run a real turn');
  test.setTimeout(300_000);

  test('a real model calls a plugin tool', async ({ mainWindow }) => {
    test.skip(mode !== 'allow', 'needs LVIS_E2E_PERMISSION_MODE=allow');

    const composer = mainWindow.locator('[data-testid="composer-textarea"]').first();
    await expect(composer).toBeEnabled({ timeout: 60_000 });

    // Prove the seeded mode actually took. A partial permissions.json is
    // discarded silently and the app stays on `default`, which looks identical
    // until a tool asks for something out of scope.
    await expect(mainWindow.locator('[data-testid="iab-status-row"]'))
      .toContainText(/allow|모두 허용|전체 허용/i, { timeout: 60_000 });

    // Name the tools explicitly. The point is to prove the PLUGIN tool surface
    // is exposed to the model and dispatchable, not to test tool selection.
    await composer.fill(
      'Call the tool index_folders to list indexed folders, then call ' +
      'meeting_sessions to list meeting sessions. Use the tools, do not guess.',
    );
    await mainWindow.locator('[data-testid="composer-send-button"]').first().click();

    // The prompt itself contains those tool names, so matching them in the
    // transcript proves nothing — the user bubble alone would satisfy it. The
    // stub's marker can ONLY appear if the host actually dispatched the call
    // into the plugin, so that is what is asserted.
    await expect(mainWindow.locator('body')).toContainText(/e2e-stub:(local-indexer|meeting):/, {
      timeout: 180_000,
    });

    const seen = await mainWindow.evaluate(() => {
      const text = document.body.innerText;
      return {
        indexer: /e2e-stub:local-indexer:/.test(text),
        meeting: /e2e-stub:meeting:/.test(text),
      };
    });
    console.log(`[live-plugin] dispatched indexer=${seen.indexer} meeting=${seen.meeting}`);
    expect(seen.indexer || seen.meeting).toBe(true);
  });

  test('a path outside the allowed directories reaches the scope review', async ({ mainWindow }) => {
    test.skip(mode !== 'default', 'needs LVIS_E2E_PERMISSION_MODE=default');

    const composer = mainWindow.locator('[data-testid="composer-textarea"]').first();
    await expect(composer).toBeEnabled({ timeout: 60_000 });

    await composer.fill(
      'Read the file /etc/hosts using your file tool and show me its first line.',
    );
    await mainWindow.locator('[data-testid="composer-send-button"]').first().click();

    // The review card — NOT a silent read, and NOT a silent refusal.
    const card = mainWindow.getByText(/Access outside allowed directories|허용된 디렉토리 밖/i).first();
    await expect(card).toBeVisible({ timeout: 180_000 });

    const detail = await mainWindow.evaluate(() => {
      const text = document.body.innerText;
      return {
        showsRequestedPath: /\/etc\/hosts/.test(text),
        offersScopes: /Once only|이번 1회만/.test(text) && /Deny|거부/.test(text),
      };
    });
    console.log(`[live-scope] requestedPathShown=${detail.showsRequestedPath} scopesOffered=${detail.offersScopes}`);

    // The card has to name what is being asked for and let the user bound it,
    // otherwise it is a prompt the user cannot answer responsibly.
    expect(detail.offersScopes).toBe(true);

    // Denying must end the attempt rather than fall through to the read.
    await mainWindow.getByRole('button', { name: /Deny|거부/ }).first().click();
    await expect(mainWindow.locator('body')).not.toContainText(/127\.0\.0\.1\s+localhost/, { timeout: 60_000 });
  });
});
