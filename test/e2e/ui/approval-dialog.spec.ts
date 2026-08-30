import { test, expect } from './fixtures.js';
import { TEST_IDS } from "../../../src/shared/test-ids.js";

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

  const dock = mainWindow.getByTestId(TEST_IDS.approvalDock).first();
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
    const body = root.querySelector<HTMLElement>('[data-testid="tool-approval-card"] > section');
    const actions = root.querySelector<HTMLElement>('[data-testid="approval-decision-actions"]');
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
      bodyOffsetWidth: body?.offsetWidth ?? -1,
      bodyClientWidth: body?.clientWidth ?? -1,
      bodyScrollWidth: body?.scrollWidth ?? -1,
      bodyClientHeight: body?.clientHeight ?? -1,
      bodyScrollHeight: body?.scrollHeight ?? -1,
      bodyScrollbarGutter: body ? getComputedStyle(body).scrollbarGutter : null,
      actionsClientWidth: actions?.clientWidth ?? -1,
      actionsScrollWidth: actions?.scrollWidth ?? -1,
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
  expect(geometry.bodyScrollbarGutter).toBe('auto');
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.bodyClientWidth);
  if (geometry.bodyScrollHeight <= geometry.bodyClientHeight) {
    expect(geometry.bodyOffsetWidth - geometry.bodyClientWidth).toBeLessThanOrEqual(2);
  }
  expect(geometry.actionsClientWidth).toBeGreaterThan(0);
  expect(geometry.actionsScrollWidth).toBeLessThanOrEqual(geometry.actionsClientWidth);

  const approve = dock.getByTestId(TEST_IDS.approveButton);
  const deny = dock.getByTestId(TEST_IDS.denyButton);
  const allowAlways = dock.getByTestId(TEST_IDS.allowAlwaysButton);
  await expect(approve).toBeVisible();
  await expect(deny).toBeVisible();
  await expect(allowAlways).toBeVisible();
  await expect(allowAlways).toBeEnabled();
  await expect(deny).toBeFocused();
  await expect(dock.locator('input, textarea, [contenteditable="true"], [role="textbox"]'))
    .toHaveCount(0);
  await expect(dock.getByTestId('approval-tool-identity')).toContainText('read_file');
  await expect(dock.getByTestId('approval-impact-summary')).toBeVisible();
  await expect(dock.getByTestId(TEST_IDS.approvalReviewDetails)).not.toHaveAttribute('open', '');
  await expect(dock.getByText(/Review details|검토 상세/)).toBeVisible();
  await expect(dock.getByText(/Click to expand|펼쳐서 확인/)).toBeVisible();
  await expect(dock.getByTestId(TEST_IDS.openPermanentDenySettings)).toBeVisible();

  // Container-based wrapping must keep long translated action labels inside
  // the narrow card even when the expanded sidebar leaves very little room.
  const translatedControlOverflow = await dock.evaluate((element) => {
    const root = element as HTMLElement;
    const replacements = new Map<string, string>([
      ['deny-button', 'Ablehnen'],
      ['allow-always-button', 'Immer dauerhaft zulassen'],
      ['approve-button', 'Nur dieses eine Mal zulassen'],
      ['open-permanent-deny-settings', 'Berechtigungseinstellungen öffnen'],
    ]);
    for (const [testId, label] of replacements) {
      const control = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (control) control.textContent = label;
    }
    const actions = root.querySelector<HTMLElement>('[data-testid="approval-decision-actions"]');
    const controls = [...replacements.keys()]
      .map((testId) => root.querySelector<HTMLElement>(`[data-testid="${testId}"]`))
      .filter((control): control is HTMLElement => control !== null);
    return {
      rootFits: root.scrollWidth <= root.clientWidth,
      actionsFit: Boolean(actions && actions.scrollWidth <= actions.clientWidth),
      controlsFit: controls.every((control) => control.scrollWidth <= control.clientWidth),
    };
  });
  expect(translatedControlOverflow).toEqual({
    rootFits: true,
    actionsFit: true,
    controlsFit: true,
  });

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
  const composerInput = mainWindow.getByTestId(TEST_IDS.composerInputBar).first();
  await expect(composerDock).toBeVisible();
  await expect(composerInput).toBeVisible();
  await expect(composerDock).toHaveAttribute('inert', '');
  await expect(composerDock).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => dock.evaluate((element) => {
    const root = element as HTMLElement;
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-input-bar"]');
    if (!composer) return false;
    const dockRect = root.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const overlapTop = Math.max(dockRect.top, composerRect.top);
    const overlapBottom = Math.min(dockRect.bottom, composerRect.bottom);
    if (overlapBottom - overlapTop < 24) return false;
    const x = Math.max(dockRect.left, composerRect.left)
      + Math.min(dockRect.width, composerRect.width) / 2;
    const y = overlapTop + (overlapBottom - overlapTop) / 2;
    return document.elementFromPoint(x, y)?.closest('[data-testid="approval-dock"]') === root;
  })).toBe(true);
  await expect(dock).toBeVisible();

  // Approval is the foreground decision surface. Like the question card, it
  // floats over the composer instead of pushing the chat layout upward; if
  // both are pending, the approval card remains the topmost surface.
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
  const questionOverlay = mainWindow.getByTestId(TEST_IDS.questionOverlay);
  await expect(questionOverlay).toBeVisible();
  await expect(composerDock).toHaveAttribute('inert', '');
  await expect(composerDock).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => dock.evaluate((element) => {
    const root = element as HTMLElement;
    const question = document.querySelector<HTMLElement>('[data-testid="question-overlay"]');
    if (!question) return false;
    const dockRect = root.getBoundingClientRect();
    const questionRect = question.getBoundingClientRect();
    const overlapTop = Math.max(dockRect.top, questionRect.top);
    const overlapBottom = Math.min(dockRect.bottom, questionRect.bottom);
    if (overlapBottom - overlapTop <= 0) return false;
    const x = Math.max(dockRect.left, questionRect.left)
      + Math.min(dockRect.width, questionRect.width) / 2;
    const y = overlapTop + (overlapBottom - overlapTop) / 2;
    return document.elementFromPoint(x, y)?.closest('[data-testid="approval-dock"]') === root;
  })).toBe(true);

  // If a question arrives while approval owns the foreground, resolving the
  // approval must hand focus to that question instead of restoring the now
  // hidden composer input beneath it.
  await approve.focus();
  await approve.press('Enter');
  await expect(dock).toHaveCount(0);
  const firstQuestionChoice = questionOverlay.getByRole('option').first();
  await expect(firstQuestionChoice).toBeFocused();
  await expect(composerDock).not.toHaveAttribute('inert', '');
  await expect(composerDock).not.toHaveAttribute('aria-hidden', 'true');

  // Re-open a deterministic approval so the remaining compact-height and
  // keyboard assertions continue against the same simultaneous-question state.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('lvis:approval:request', {
      id: 'approval-dock-layout-continuation-e2e',
      category: 'tool',
      kind: 'tool',
      toolName: `read_file_${'long_identity_'.repeat(16)}`,
      toolCategory: 'read',
      source: 'builtin',
      trustOrigin: 'user-keyboard',
      args: { path: 'C:\\workspace\\approval-dock-layout-continuation-e2e.txt' },
      reason: 'deterministic approval dock continuation fixture',
      createdAt: Date.now(),
      requireExplicit: false,
    });
  });
  await expect(dock).toBeVisible();
  await expect(deny).toBeFocused();
  await expect(composerDock).toHaveAttribute('inert', '');
  await expect(composerDock).toHaveAttribute('aria-hidden', 'true');

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
  const reviewDetails = dock.getByTestId(TEST_IDS.approvalReviewDetails);
  await reviewDetails.locator('summary').click();
  await expect(reviewDetails).toHaveAttribute('open', '');
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

  await approve.focus();
  await approve.press('ArrowLeft');
  await expect(allowAlways).toBeFocused();
  await allowAlways.press('ArrowLeft');
  await expect(deny).toBeFocused();
  await deny.press('ArrowRight');
  await expect(allowAlways).toBeFocused();
  await allowAlways.press('ArrowRight');
  await expect(approve).toBeFocused();
  await approve.press('Enter');
  await expect(dock).toHaveCount(0);

  // Space retains native button activation as well; the dock must not swallow
  // it while providing its own Left/Right roving behavior.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    win?.webContents.send('lvis:approval:request', {
      id: 'approval-dock-space-e2e',
      category: 'tool',
      kind: 'tool',
      toolName: 'read_file_space_activation',
      toolCategory: 'read',
      source: 'builtin',
      trustOrigin: 'user-keyboard',
      args: { path: 'C:\\workspace\\approval-dock-space-e2e.txt' },
      reason: 'space activation fixture',
      createdAt: Date.now(),
      requireExplicit: false,
    });
  });
  await expect(dock).toBeVisible();
  const secondApprove = dock.getByTestId(TEST_IDS.approveButton);
  const secondDeny = dock.getByTestId(TEST_IDS.denyButton);
  const secondAlways = dock.getByTestId(TEST_IDS.allowAlwaysButton);
  await expect(secondDeny).toBeFocused();
  await secondDeny.press('ArrowRight');
  await expect(secondAlways).toBeFocused();
  await secondAlways.press('ArrowRight');
  await expect(secondApprove).toBeFocused();
  await secondApprove.press('Space');
  await expect(dock).toHaveCount(0);
});
