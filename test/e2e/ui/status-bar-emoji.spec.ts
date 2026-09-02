import { test, expect } from './fixtures';

/**
 * The persistent identity surface moved from the notification-only StatusBar
 * into the unified composer status row. Verify the current contract without
 * depending on OS-specific emoji rendering.
 */
test('composer status row exposes permission, model and reasoning — and no connection dot', async ({ mainWindow }) => {
  const row = mainWindow.locator('[data-testid="iab-status-row"]');
  await expect(row).toBeVisible({ timeout: 15_000 });

  const permission = row.locator('[data-testid="iab-status-permission"]');
  await expect(permission).toBeVisible();
  await expect(permission).toHaveAttribute('data-mode', /^(default|strict|auto|allow)$/);
  await expect(permission).toHaveAttribute('title', /.+/);

  const model = row.locator('[data-testid="iab-status-model"]');
  await expect(model).toBeVisible();
  await expect(model).toHaveAttribute('title', /.+/);

  await expect(row.locator('[data-testid="iab-status-reasoning"]')).toBeVisible();
  // "Model configured" is no longer a row cell; it alerts on the sidebar's
  // Settings entry only when it is missing.
  await expect(row.locator('[data-testid="iab-status-active-dot"]')).toHaveCount(0);
});

test('composer status row does not render the deprecated account identity', async ({ mainWindow }) => {
  const row = mainWindow.locator('[data-testid="iab-status-row"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).not.toContainText(/[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+/);
});
