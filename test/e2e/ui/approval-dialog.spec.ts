import { test, expect } from './fixtures.js';

/**
 * Compatibility filename: this used to exercise the foreground dialog; the
 * assertions now pin the replacement in-flow dock.
 *
 * Foreground approval smoke: inject one real main-to-renderer request and
 * verify the route-independent dock without relying on an ambient tool run.
 */
test('approval dock remains non-modal and route-independent', async ({
  app,
  mainWindow,
  t,
}) => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.setContentSize(460, 841);
  });

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('lvis:approval:request', {
      id: 'approval-dock-e2e',
      category: 'tool',
      kind: 'tool',
      toolName: `read_file_${'long_identity_'.repeat(16)}`,
      toolCategory: 'read',
      source: 'builtin',
      trustOrigin: 'user-keyboard',
      args: { path: 'C:\\workspace\\approval-dock-e2e.txt' },
      reason: 'deterministic approval dock e2e fixture',
      createdAt: Date.now(),
      requireExplicit: false,
    });
  });

  const dock = mainWindow.getByTestId('approval-dock').first();
  await expect(dock).toBeVisible();
  await expect(dock).toHaveAttribute('role', 'region');
  await expect(dock).not.toHaveAttribute('aria-modal', 'true');
  await expect(dock.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0);
  expect(await mainWindow.locator('body').getAttribute('data-scroll-locked')).toBeNull();
  expect(await mainWindow.locator('main').getAttribute('inert')).toBeNull();
  await expect(mainWindow.locator('main')).not.toHaveAttribute('aria-hidden', 'true');

  const geometry = await dock.evaluate((element) => {
    const root = element as HTMLElement;
    const panel = root.querySelector<HTMLElement>('[data-testid="tool-approval-panel"]');
    const scopes = root.querySelector<HTMLElement>('[data-testid="approval-scope-options"]');
    const rect = root.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      dockClientWidth: root.clientWidth,
      dockScrollWidth: root.scrollWidth,
      panelClientWidth: panel?.clientWidth ?? -1,
      panelScrollWidth: panel?.scrollWidth ?? -1,
      scopesClientWidth: scopes?.clientWidth ?? -1,
      scopesScrollWidth: scopes?.scrollWidth ?? -1,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.dockScrollWidth).toBeLessThanOrEqual(geometry.dockClientWidth);
  expect(geometry.panelScrollWidth).toBeLessThanOrEqual(geometry.panelClientWidth);
  expect(geometry.scopesClientWidth).toBeGreaterThan(0);
  expect(geometry.scopesScrollWidth).toBeLessThanOrEqual(geometry.scopesClientWidth);

  const approve = dock
    .locator(
      `button:has-text("Approve"), button:has-text("승인"), button:has-text(${JSON.stringify(t('toolApprovalDialog.allowOnce'))})`,
    )
    .first();
  const deny = dock
    .locator(
      `button:has-text("Deny"), button:has-text("Reject"), button:has-text(${JSON.stringify(t('toolApprovalDialog.denyOnce'))})`,
    )
    .first();
  expect((await approve.count()) + (await deny.count())).toBeGreaterThanOrEqual(1);

  const workBoard = mainWindow.getByTestId('toolbar-work-board');
  await workBoard.click();
  // The breadcrumb is intentionally hidden at 460px; verify the routed body,
  // not a desktop-only navigation label.
  await expect(mainWindow.getByTestId('work-board-panel')).toBeVisible();
  await expect(dock).toBeVisible();

  await workBoard.focus();
  await workBoard.press('d');
  await expect(dock).toBeVisible();

  await deny.focus();
  await deny.press('d');
  await expect(dock).toHaveCount(0);
});
