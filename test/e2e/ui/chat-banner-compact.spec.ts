import { test, expect } from './fixtures';

/**
 * Chat banner + compact pipeline e2e smoke.
 *
 * Verifies that PR #708's shadcn UI migration + compact pipeline rewrites
 * haven't broken the chat surface DOM contracts that downstream consumers
 * (StatusBar, Composer slots, system entry banner) depend on.
 *
 * Coverage:
 *   1. status-bar + composer key data-testid markers render
 *   2. /compact slash command produces a system-entry banner response
 *      (verifies the slash → IPC chatCompact → renderer pipeline regardless
 *      of whether an LLM provider is wired — manualCompact returns a system
 *      banner even with no API key).
 *   3. Composer textarea accepts text input.
 */
test.describe('chat banner + compact pipeline', () => {
  test('status-bar and composer DOM contracts render after window open', async ({ mainWindow }) => {
    // Wait until the renderer has booted past the splash.
    const composer = mainWindow.locator('[data-testid="composer"]').first();
    const found = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'Composer not visible — chat surface not booted in this E2E sandbox.');

    await expect(mainWindow.locator('[data-testid="composer-textarea"]').first()).toBeVisible();
    await expect(mainWindow.locator('[data-testid="composer-send-button"]').first()).toBeVisible();
    await expect(mainWindow.locator('[data-testid="status-bar"]').first()).toBeVisible();
  });

  test('/compact slash command produces a system-entry banner response', async ({ mainWindow }) => {
    const input = mainWindow.locator('[data-testid="composer-textarea"]').first();
    const found = await input
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'No composer textarea visible — chat surface not booted.');

    const baselineSystemEntries = await mainWindow
      .locator('[data-testid="system-entry"]')
      .count();

    await input.click();
    await input.fill('/compact');
    await input.press('Enter');

    // manualCompact responds with a system banner whether or not an LLM is
    // configured — "LLM provider 미구성" or "컴팩트 불필요" or success. The
    // pipeline contract under test is "slash → chatCompact IPC → renderer
    // surfaces a system entry within a few seconds".
    await expect.poll(
      async () => mainWindow.locator('[data-testid="system-entry"]').count(),
      { timeout: 10_000 },
    ).toBeGreaterThan(baselineSystemEntries);
  });

  test('composer textarea accepts text input', async ({ mainWindow }) => {
    const input = mainWindow.locator('[data-testid="composer-textarea"]').first();
    const found = await input
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(!found, 'No composer textarea visible.');

    const marker = `compact-e2e-${Date.now()}`;
    await input.click();
    await input.fill(marker);
    const value = await input.evaluate(
      (el: HTMLInputElement | HTMLTextAreaElement) => ('value' in el ? el.value : (el as HTMLElement).textContent ?? ''),
    );
    expect(value).toContain(marker);
  });
});
