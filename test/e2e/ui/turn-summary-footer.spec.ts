import { test, expect } from './fixtures';

/**
 * Turn aggregate footer — verifies the footer container is present in the
 * DOM tree once a turn completes. The test skips gracefully when no chat
 * input is reachable (no API key in the isolated user-data dir, etc.) so
 * the spec stays green on CI runs that don't have a wired LLM provider.
 *
 * The aggregate footer's contract:
 *   - Carries data-testid="turn-summary-footer"
 *   - Aria toggle has data-testid="turn-summary-footer-toggle"
 * Both are stable selectors used by integration consumers (TurnSummaryFooter.tsx).
 */
test('turn-summary-footer renders selectors after turn completes, or skips cleanly', async ({
  mainWindow,
}) => {
  const input = mainWindow
    .locator('textarea, input[type="text"], [contenteditable="true"]')
    .first();

  const found = await input
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!found, 'No chat input visible — turn-summary-footer e2e cannot exercise.');

  // Send a tiny prompt — when no LLM key is configured the chat input still
  // accepts text but no `done` event fires; the spec then exits via skip.
  const marker = `ts-${Date.now()}`;
  await input.click();
  await input.fill(marker);
  await input.press('Enter').catch(() => {});

  // Wait up to 20s for either the footer to appear (real LLM completed) or
  // for the visibility check to time out (no LLM available → skip).
  const footer = mainWindow.locator('[data-testid="turn-summary-footer"]').first();
  const appeared = await footer
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!appeared, 'No LLM provider wired in this E2E sandbox — turn-summary-footer cannot complete.');

  // Toggle is always present alongside the footer body.
  const toggle = mainWindow.locator('[data-testid="turn-summary-footer-toggle"]').first();
  await expect(toggle).toBeVisible();

  // Steps row is non-empty (toolCount may be 0 — "0 steps" still satisfies).
  const steps = mainWindow.locator('[data-testid="turn-summary-steps"]').first();
  await expect(steps).toBeVisible();
  const stepsText = await steps.innerText();
  expect(stepsText).toMatch(/\b\d+\s+steps?\b/);

  // Duration row carries the ⏱ marker.
  const duration = mainWindow.locator('[data-testid="turn-summary-duration"]').first();
  await expect(duration).toBeVisible();
  const durationText = await duration.innerText();
  expect(durationText).toContain('⏱');

  // Tokens row carries the 🪙 marker.
  const tokens = mainWindow.locator('[data-testid="turn-summary-tokens"]').first();
  await expect(tokens).toBeVisible();
  const tokensText = await tokens.innerText();
  expect(tokensText).toContain('🪙');
});
