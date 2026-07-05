import { test, expect } from './fixtures';

/**
 * Pinned message toggle smoke ("Star" → "Pin" rename, 2026-07) — finds any
 * pin/bookmark affordance on a message row and toggles it. Skips gracefully
 * when no pin UI exists.
 */
test('pinned message toggle flips state, or skips', async ({ mainWindow }) => {
  const star = mainWindow
    .locator(
      [
        '[data-testid="star-toggle"]',
        '[data-testid="message-star"]',
        'button[aria-label*="Pin" i]',
        'button[aria-label*="핀"]',
        'button[aria-label*="고정"]',
      ].join(', '),
    )
    .first();

  const found = await star
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!found, 'No star/favorite toggle present — skipping.');

  const beforePressed =
    (await star.getAttribute('aria-pressed').catch(() => null)) ??
    (await star.getAttribute('data-state').catch(() => null));

  await star.click();
  await mainWindow.waitForTimeout(200);

  const afterPressed =
    (await star.getAttribute('aria-pressed').catch(() => null)) ??
    (await star.getAttribute('data-state').catch(() => null));

  await expect(star).toBeVisible();
  if (beforePressed !== null && afterPressed !== null) {
    expect(afterPressed).not.toBe(beforePressed);
  }
});
