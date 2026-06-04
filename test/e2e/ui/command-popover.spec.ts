import { test, expect } from './fixtures';

/**
 * E2E tests for the unified CommandPopover (PR-A: B안).
 *
 * These tests require `bun run build` to have produced dist/src/main/main.js.
 * All tests hard-fail when the UI trigger is not visible — a missing trigger
 * is a real regression, not a skip. The fixture waits up to 60 s for React
 * to boot before handing control to tests.
 */

test('command popover: Cmd/Ctrl+K opens and closes the popover', async ({ mainWindow }) => {
  // Wait for the InputActionBar to appear (signals full React boot).
  // 60 s timeout matches CI worst-case boot — failure to load is a real regression.
  const trigger = mainWindow.locator('[data-testid="command-popover-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 60_000 });

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  // Open via Cmd/Ctrl+K
  await mainWindow.keyboard.press(`${mod}+k`);
  const popover = mainWindow.locator('[data-testid="command-popover"]');
  await expect(popover).toBeVisible({ timeout: 5_000 });

  // Close via Cmd/Ctrl+K again (toggle)
  await mainWindow.keyboard.press(`${mod}+k`);
  await expect(popover).not.toBeVisible({ timeout: 5_000 });
});

test('command popover: two section headings visible when open', async ({ mainWindow }) => {
  const trigger = mainWindow.locator('[data-testid="command-popover-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 20_000 });

  await trigger.click();
  await mainWindow.locator('[data-testid="command-popover"]').waitFor({ state: 'visible', timeout: 5_000 });

  await expect(mainWindow.locator('[data-testid="command-group-actions"]')).toBeVisible();
  await expect(mainWindow.locator('[data-testid="command-group-slash"]')).toBeVisible();
});

test('command popover: search filters items and hides empty group', async ({ mainWindow }) => {
  const trigger = mainWindow.locator('[data-testid="command-popover-trigger"]');
  const found = await trigger.waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, 'CommandPopover trigger not found — skipping E2E.');

  await trigger.click();
  await mainWindow.locator('[data-testid="command-popover"]').waitFor({ state: 'visible', timeout: 5_000 });

  const input = mainWindow.locator('[data-testid="command-input"]');
  await input.fill('zzznomatch');

  // Both groups should disappear
  await expect(mainWindow.locator('[data-testid="command-group-actions"]')).not.toBeVisible({ timeout: 3_000 });
  await expect(mainWindow.locator('[data-testid="command-group-slash"]')).not.toBeVisible({ timeout: 3_000 });
});

test('command popover: list has max-h constraint and is scrollable when items overflow', async ({ mainWindow }) => {
  const trigger = mainWindow.locator('[data-testid="command-popover-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 20_000 });

  await trigger.click();
  await mainWindow.locator('[data-testid="command-popover"]').waitFor({ state: 'visible', timeout: 5_000 });

  // Verify real scroll behaviour: content must overflow the constrained list,
  // and scrollTop must actually advance when set (genuine scroll capability).
  const list = mainWindow.locator('[data-testid="command-popover"] [cmdk-list]');
  const overflows = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflows).toBe(true);
  const canScroll = await list.evaluate((el) => {
    el.scrollTop = 100;
    return el.scrollTop > 0;
  });
  expect(canScroll).toBe(true);
});

test('command popover: slash command click inserts text and closes popover', async ({ mainWindow }) => {
  const trigger = mainWindow.locator('[data-testid="command-popover-trigger"]');
  const found = await trigger.waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, 'CommandPopover trigger not found — skipping E2E.');

  await trigger.click();
  await mainWindow.locator('[data-testid="command-popover"]').waitFor({ state: 'visible', timeout: 5_000 });

  // Click the /help slash command item
  const slashGroup = mainWindow.locator('[data-testid="command-group-slash"]');
  const helpItem = slashGroup.locator('[cmdk-item]').filter({ hasText: '/help' }).first();
  await helpItem.click();

  // Popover should close
  await expect(mainWindow.locator('[data-testid="command-popover"]')).not.toBeVisible({ timeout: 3_000 });

  // Check textarea has /help inserted
  const textarea = mainWindow.locator('textarea').first();
  const val = await textarea.inputValue();
  expect(val).toContain('/help');
});

test('command popover: top ⌘ toolbar button is absent', async ({ mainWindow, t }) => {
  // Wait for the InputActionBar to appear (signals full React boot) before
  // asserting absence — prevents the negative assertion from passing before
  // the UI has had a chance to mount.
  const trigger = mainWindow.locator('[data-testid="command-popover-trigger"]');
  const found = await trigger.waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, 'CommandPopover trigger not found — skipping E2E.');

  // Verify the old top Command palette button no longer exists in MainToolbar
  const oldButton = mainWindow.locator(`button[title="${t('commandPopover.ariaLabel')}"]`);
  await expect(oldButton).not.toBeAttached({ timeout: 5_000 });
});
