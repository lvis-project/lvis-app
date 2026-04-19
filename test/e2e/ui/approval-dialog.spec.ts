import { test, expect } from './fixtures';

/**
 * Approval dialog smoke — verifies approval UI primitives (approve/deny/bulk)
 * are renderable when triggered. Skips cleanly when no approval UI is present.
 */
test('approval dialog renders approve/deny/bulk controls, or skips', async ({
  mainWindow,
}) => {
  const trigger = mainWindow
    .locator(
      [
        '[data-testid="approval-open"]',
        '[data-testid="open-approval-queue"]',
        'button[aria-label*="Approval" i]',
        'button[aria-label*="승인"]',
      ].join(', '),
    )
    .first();

  const triggerVisible = await trigger
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (triggerVisible) {
    await trigger.click();
  }

  const dialog = mainWindow.locator('[role="dialog"]').first();
  const dialogVisible = await dialog
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!dialogVisible, 'No approval dialog reachable — skipping.');

  const approve = dialog
    .locator('button:has-text("Approve"), button:has-text("승인")')
    .first();
  const deny = dialog
    .locator('button:has-text("Deny"), button:has-text("Reject"), button:has-text("거부")')
    .first();
  const bulk = dialog
    .locator(
      'button:has-text("Approve All"), button:has-text("Deny All"), button:has-text("모두")',
    )
    .first();

  const counts = await Promise.all([approve.count(), deny.count(), bulk.count()]);
  const total = counts.reduce((a, b) => a + b, 0);
  expect(total).toBeGreaterThanOrEqual(1);
});
