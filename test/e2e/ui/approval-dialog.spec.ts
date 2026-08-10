import { test, expect } from './fixtures.js';

/**
 * Compatibility filename: this used to exercise the foreground dialog; the
 * assertions now pin the replacement bottom-floating dock.
 *
 * Foreground approval smoke: inject one real main-to-renderer request and
 * verify the route-independent dock without relying on an ambient tool run.
 */
test('approval dock floats over the route without changing its layout', async ({
  app,
  mainWindow,
}) => {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.setContentSize(460, 841);
  });
  await expect.poll(() => mainWindow.evaluate(() => (
    Math.abs(window.innerWidth - 460) <= 1
    && Math.abs(window.innerHeight - 841) <= 1
  ))).toBe(true);

  const sidebarToggle = mainWindow.getByTestId('sidebar-collapse-toggle');
  if ((await sidebarToggle.getAttribute('aria-pressed')) !== 'true') {
    await sidebarToggle.click();
  }
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true');

  const workBoard = mainWindow.getByTestId('toolbar-work-board');
  await workBoard.click();
  const workBoardPanel = mainWindow.getByTestId('work-board-panel');
  await expect(workBoardPanel).toBeVisible();
  const routeBefore = await workBoardPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
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
    const canvas = root.closest<HTMLElement>('[data-testid="route-canvas"]');
    const panel = root.querySelector<HTMLElement>('[data-testid="tool-approval-panel"]');
    const scopes = root.querySelector<HTMLElement>('[data-testid="approval-scope-options"]');
    const sidebar = document.querySelector<HTMLElement>('[data-testid="primary-sidebar"]');
    const rect = root.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    return {
      position: getComputedStyle(root).position,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      canvasLeft: canvasRect?.left ?? -1,
      canvasRight: canvasRect?.right ?? -1,
      canvasBottom: canvasRect?.bottom ?? -1,
      sidebarRight: sidebarRect?.right ?? -1,
      dockClientWidth: root.clientWidth,
      dockScrollWidth: root.scrollWidth,
      panelClientWidth: panel?.clientWidth ?? -1,
      panelScrollWidth: panel?.scrollWidth ?? -1,
      scopesClientWidth: scopes?.clientWidth ?? -1,
      scopesScrollWidth: scopes?.scrollWidth ?? -1,
    };
  });
  expect(geometry.position).toBe('absolute');
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.canvasLeft + 8);
  expect(geometry.left).toBeGreaterThanOrEqual(geometry.sidebarRight + 8);
  expect(geometry.right).toBeLessThanOrEqual(geometry.canvasRight - 8);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.canvasBottom - 8);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.dockScrollWidth).toBeLessThanOrEqual(geometry.dockClientWidth);
  expect(geometry.panelScrollWidth).toBeLessThanOrEqual(geometry.panelClientWidth);
  expect(geometry.scopesClientWidth).toBeGreaterThan(0);
  expect(geometry.scopesScrollWidth).toBeLessThanOrEqual(geometry.scopesClientWidth);

  const approve = dock.getByTestId('approve-button');
  const deny = dock.getByTestId('deny-button');
  await expect(approve).toBeVisible();
  await expect(deny).toBeVisible();

  const routeAfter = await workBoardPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  });
  expect(routeAfter.left).toBeCloseTo(routeBefore.left, 0);
  expect(routeAfter.top).toBeCloseTo(routeBefore.top, 0);
  expect(routeAfter.width).toBeCloseTo(routeBefore.width, 0);
  expect(routeAfter.height).toBeCloseTo(routeBefore.height, 0);

  // A real route transition remains interactive while the floating card stays
  // mounted above the route canvas.
  await mainWindow.getByTestId('sidebar-home').click();
  await expect(workBoardPanel).toBeHidden();
  const composerDock = mainWindow.locator('[data-composer-placement]').first();
  await expect(composerDock).toBeVisible();
  await expect.poll(async () => {
    const [dockRect, composerRect] = await Promise.all([
      dock.boundingBox(),
      composerDock.boundingBox(),
    ]);
    return dockRect !== null
      && composerRect !== null
      && dockRect.y + dockRect.height <= composerRect.y - 6;
  }).toBe(true);
  await expect(dock).toBeVisible();

  // The question card is another non-modal foreground surface inside the
  // composer dock. When both queues are pending, approval stays above the
  // question card instead of covering it.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('lvis:ask-user-question:request', {
      id: 'approval-dock-question-overlap-e2e',
      createdAt: Date.now(),
      questions: [{
        question: 'Which report range should be used?',
        choices: ['Today', 'This week', 'This month'],
      }],
    });
  });
  const questionOverlay = mainWindow.getByTestId('question-overlay');
  await expect(questionOverlay).toBeVisible();
  await expect.poll(async () => {
    const [dockRect, questionRect] = await Promise.all([
      dock.boundingBox(),
      questionOverlay.boundingBox(),
    ]);
    return dockRect !== null
      && questionRect !== null
      && dockRect.y + dockRect.height <= questionRect.y - 6;
  }).toBe(true);

  // At the minimum supported height, only the card body scrolls; the header
  // and decision footer remain visible and the route still keeps its height.
  await workBoard.click();
  await expect(workBoardPanel).toBeVisible();
  // Window-mode resize tweens can legitimately update native bounds while the
  // route changes. Use an explicit CDP renderer viewport override for the
  // deterministic minimum-layout assertion.
  const cdp = await mainWindow.context().newCDPSession(mainWindow);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 460,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await expect.poll(() => mainWindow.evaluate(() => (
    Math.abs(window.innerWidth - 460) <= 1
    && Math.abs(window.innerHeight - 640) <= 1
  ))).toBe(true);
  const compactGeometry = await dock.evaluate((element) => {
    const root = element as HTMLElement;
    const header = root.querySelector<HTMLElement>(':scope > header');
    const card = root.querySelector<HTMLElement>('[data-testid="tool-approval-card"]');
    const body = card?.querySelector<HTMLElement>(':scope > section');
    const footer = card?.lastElementChild as HTMLElement | null;
    const rootRect = root.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      height: rootRect.height,
      maxViewportHeight: window.innerHeight * 0.48,
      headerInside: (headerRect?.top ?? -1) >= rootRect.top - 1
        && (headerRect?.bottom ?? Number.POSITIVE_INFINITY) <= rootRect.bottom + 1,
      footerInside: (footerRect?.top ?? -1) >= rootRect.top - 1
        && (footerRect?.bottom ?? Number.POSITIVE_INFINITY) <= rootRect.bottom + 1,
      bodyClientHeight: body?.clientHeight ?? -1,
      bodyScrollHeight: body?.scrollHeight ?? -1,
      bodyClientWidth: body?.clientWidth ?? -1,
      bodyScrollWidth: body?.scrollWidth ?? -1,
      footerClientWidth: footer?.clientWidth ?? -1,
      footerScrollWidth: footer?.scrollWidth ?? -1,
    };
  });
  expect(compactGeometry.height).toBeLessThanOrEqual(compactGeometry.maxViewportHeight + 1);
  expect(compactGeometry.headerInside).toBe(true);
  expect(compactGeometry.footerInside).toBe(true);
  expect(compactGeometry.bodyClientHeight).toBeGreaterThan(0);
  expect(compactGeometry.bodyScrollHeight).toBeGreaterThan(compactGeometry.bodyClientHeight);
  expect(compactGeometry.bodyScrollWidth).toBeLessThanOrEqual(compactGeometry.bodyClientWidth);
  expect(compactGeometry.footerScrollWidth).toBeLessThanOrEqual(compactGeometry.footerClientWidth);
  const scrollBody = dock.locator('[data-testid="tool-approval-card"] > section').first();
  await scrollBody.evaluate((element) => {
    element.scrollTop = Math.min(48, element.scrollHeight - element.clientHeight);
  });
  await expect.poll(() => scrollBody.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(approve).toBeVisible();
  await expect(deny).toBeVisible();

  await workBoard.focus();
  await workBoard.press('d');
  await expect(dock).toBeVisible();

  await deny.focus();
  await deny.press('d');
  await expect(dock).toHaveCount(0);
});
