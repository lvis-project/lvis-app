import { test, expect } from './fixtures';

async function setWindowSize(app: import('@playwright/test').ElectronApplication, w: number, h: number) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && window.isVisible());
    const target = windows.sort((a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1])[0];
    if (target) target.setContentSize(size.w, size.h);
  }, { w, h });
}

async function readNarrowLayoutMetrics(page: import('@playwright/test').Page) {
  const session = await page.context().newCDPSession(page);
  try {
    const evaluation = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.querySelector('[data-settings-layout]');
        const panel = root?.querySelector('[role="tabpanel"][data-state="active"]');
        if (!(root instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
          return { viewportOverflow: -1, rootOverflow: -1, panelOverflow: -1, childOverflow: -1 };
        }
        const panelRect = panel.getBoundingClientRect();
        // A locally scrollable/hidden container intentionally clips wide content
        // (for example, a data table). Measure the portion that is actually
        // visible beyond its clipping ancestors, not the raw child rectangle.
        const visibleRight = (node) => {
          let right = node.getBoundingClientRect().right;
          for (
            let ancestor = node.parentElement;
            ancestor && ancestor !== panel;
            ancestor = ancestor.parentElement
          ) {
            const overflowX = getComputedStyle(ancestor).overflowX;
            if (['auto', 'scroll', 'hidden', 'clip'].includes(overflowX)) {
              right = Math.min(right, ancestor.getBoundingClientRect().right);
            }
          }
          return right;
        };
        const rightmost = Array.from(panel.querySelectorAll('*')).reduce((max, node) => {
          if (!(node instanceof HTMLElement)) return max;
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return max;
          return Math.max(max, visibleRight(node));
        }, panelRect.right);
        const offenders = Array.from(panel.querySelectorAll('*'))
          .map((node) => {
            if (!(node instanceof HTMLElement)) return null;
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return null;
            const visibleRightEdge = visibleRight(node);
            return {
              tag: node.tagName,
              className: node.className,
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
              rightOverflow: Math.ceil(visibleRightEdge - panelRect.right),
              text: (node.textContent || '').trim().slice(0, 80),
            };
          })
          .filter((item) => item && (item.rightOverflow > 1 || item.scrollWidth - item.clientWidth > 1))
          .slice(0, 12);
        return {
          viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rootOverflow: root.scrollWidth - root.clientWidth,
          panelOverflow: panel.scrollWidth - panel.clientWidth,
          childOverflow: Math.max(0, Math.ceil(rightmost - panelRect.right)),
          offenders,
        };
      })()`,
      returnByValue: true,
    });
    return evaluation.result.value as {
      viewportOverflow: number;
      rootOverflow: number;
      panelOverflow: number;
      childOverflow: number;
      offenders: Array<{ tag: string; className: string; clientWidth: number; scrollWidth: number; rightOverflow: number; text: string }>;
    };
  } finally {
    await session.detach();
  }
}

async function expectNoHorizontalOverflow(
  page: import('@playwright/test').Page,
  label: string,
) {
  const metrics = await readNarrowLayoutMetrics(page);
  if (metrics.childOverflow > 1) console.log(`[narrow-layout] ${label}`, metrics);
  expect(metrics.viewportOverflow, `${label}: viewport overflow`).toBeLessThanOrEqual(1);
  expect(metrics.rootOverflow, `${label}: settings root overflow`).toBeLessThanOrEqual(1);
  expect(metrics.childOverflow, `${label}: visible child exceeds the panel`).toBeLessThanOrEqual(1);
}

type ClippedControlMetric = {
  width: number;
  visibleWidth: number;
  height: number;
  visibleHeight: number;
};

async function readTestIdVisibilityViaCdp(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<ClippedControlMetric[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const selector = `[data-testid="${testId}"]`;
    const evaluation = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const clips = (value) => ["auto", "scroll", "hidden", "clip"].includes(value);
        return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((node) => {
          if (!(node instanceof HTMLElement)) return null;
          const rect = node.getBoundingClientRect();
          let left = 0;
          let top = 0;
          let right = window.innerWidth;
          let bottom = window.innerHeight;
          for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const ancestorRect = ancestor.getBoundingClientRect();
            if (clips(style.overflowX)) {
              left = Math.max(left, ancestorRect.left);
              right = Math.min(right, ancestorRect.right);
            }
            if (clips(style.overflowY)) {
              top = Math.max(top, ancestorRect.top);
              bottom = Math.min(bottom, ancestorRect.bottom);
            }
          }
          return {
            width: rect.width,
            visibleWidth: Math.max(0, Math.min(right, rect.right) - Math.max(left, rect.left)),
            height: rect.height,
            visibleHeight: Math.max(0, Math.min(bottom, rect.bottom) - Math.max(top, rect.top)),
          };
        }).filter(Boolean);
      })()`,
      returnByValue: true,
    });
    return (evaluation.result.value ?? []) as ClippedControlMetric[];
  } finally {
    await session.detach();
  }
}

async function expectTestIdFullyVisibleViaCdp(
  page: import('@playwright/test').Page,
  testId: string,
  label: string,
) {
  await page.getByTestId(testId).first().scrollIntoViewIfNeeded();
  const metrics = await readTestIdVisibilityViaCdp(page, testId);
  expect(metrics.length, `${label}: control missing`).toBeGreaterThan(0);
  for (const metric of metrics) {
    expect(metric.visibleWidth, `${label}: control clipped horizontally`).toBeGreaterThanOrEqual(metric.width - 1);
    expect(metric.visibleHeight, `${label}: control clipped vertically`).toBeGreaterThanOrEqual(metric.height - 1);
  }
}
type SwitchAppearance = {
  state: string | null;
  width: number;
  height: number;
  backgroundColor: string;
  borderColor: string;
  opacity: number;
  thumbWidth: number;
  thumbHeight: number;
  thumbOffsetX: number;
  thumbBackgroundColor: string;
  thumbOpacity: number;
};

async function readSwitchAppearanceViaCdp(
  page: import('@playwright/test').Page,
  testId: string,
): Promise<SwitchAppearance | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const selector = `[data-testid="${testId}"]`;
    const evaluation = await session.send('Runtime.evaluate', {
      expression: `(() => {
        const control = document.querySelector(${JSON.stringify(selector)});
        if (!(control instanceof HTMLElement)) return null;
        const thumb = control.querySelector('[data-slot="switch-thumb"]');
        const controlRect = control.getBoundingClientRect();
        const controlStyle = getComputedStyle(control);
        if (!(thumb instanceof HTMLElement)) {
          return {
            state: control.getAttribute('data-state'),
            width: controlRect.width,
            height: controlRect.height,
            backgroundColor: controlStyle.backgroundColor,
            borderColor: controlStyle.borderTopColor,
            opacity: Number(controlStyle.opacity),
            thumbWidth: 0,
            thumbHeight: 0,
            thumbOffsetX: 0,
            thumbBackgroundColor: '',
            thumbOpacity: 0,
          };
        }
        const thumbRect = thumb.getBoundingClientRect();
        const thumbStyle = getComputedStyle(thumb);
        return {
          state: control.getAttribute('data-state'),
          width: controlRect.width,
          height: controlRect.height,
          backgroundColor: controlStyle.backgroundColor,
          borderColor: controlStyle.borderTopColor,
          opacity: Number(controlStyle.opacity),
          thumbWidth: thumbRect.width,
          thumbHeight: thumbRect.height,
          thumbOffsetX: thumbRect.left - controlRect.left,
          thumbBackgroundColor: thumbStyle.backgroundColor,
          thumbOpacity: Number(thumbStyle.opacity),
        };
      })()`,
      returnByValue: true,
    });
    return (evaluation.result.value ?? null) as SwitchAppearance | null;
  } finally {
    await session.detach();
  }
}
test('Chat-mode settings stay horizontally contained on every narrow tab (CDP)', async ({ app, mainWindow }) => {
  test.slow();

  const chatMode = mainWindow.getByTestId('app-mode-chat');
  if (await chatMode.getAttribute('aria-pressed') !== 'true') {
    await chatMode.click();
  }
  await expect(chatMode).toHaveAttribute('aria-pressed', 'true');

  await mainWindow.evaluate(() => {
    const api = (window as unknown as { lvisApi: { openSettingsWindow: (tab?: string) => unknown } }).lvisApi;
    void api.openSettingsWindow('llm');
  });
  await expect(mainWindow.getByTestId('settings-sidebar-heading')).toBeVisible({ timeout: 15_000 });
  const close = mainWindow.getByTestId('settings-close');
  await expect(close).toBeVisible();
  const closeAlignment = await close.evaluate((button) => {
    const parent = button.parentElement?.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    return {
      rightInset: parent ? Math.round(parent.right - rect.right) : Number.POSITIVE_INFINITY,
    };
  });
  expect(closeAlignment.rightInset, 'settings close is right-aligned').toBeLessThanOrEqual(24);

  await setWindowSize(app, 400, 820);
  const root = mainWindow.locator('[data-settings-layout]');
  await expect.poll(async () => root.getAttribute('data-settings-layout'), { timeout: 5_000 }).toBe('narrow');

  const back = mainWindow.getByTestId('settings-mobile-back');
  if (await back.isVisible()) await back.click();
  await expect(mainWindow.getByTestId('settings-mobile-list')).toBeVisible();

  const tabCount = await root.getByRole('tab').count();
  expect(tabCount).toBeGreaterThan(0);

  for (let index = 0; index < tabCount; index += 1) {
    const tab = root.getByRole('tab').nth(index);
    const label = (await tab.textContent())?.trim() || `tab ${index + 1}`;
    await tab.click();
    await expect(back).toBeVisible();
    await expectNoHorizontalOverflow(mainWindow, label);
    const startupToggleIds = ['startup-shortcut-enabled', 'startup-launch-at-startup', 'startup-launch-minimized'];
    for (const testId of startupToggleIds) {
      const toggle = mainWindow.getByTestId(testId);
      if (await toggle.isVisible()) {
        await expect(toggle, `${label}: ${testId} visible`).toBeVisible();
        await expectTestIdFullyVisibleViaCdp(mainWindow, testId, `${label}: ${testId}`);
      }
    }

    const startupSwitch = mainWindow.getByTestId('startup-shortcut-enabled');
    if (await startupSwitch.isVisible()) {
      await expect(startupSwitch, `${label}: startup switch enabled`).toBeEnabled();
      const before = await readSwitchAppearanceViaCdp(mainWindow, 'startup-shortcut-enabled');
      expect(before, `${label}: startup switch missing from CDP`).not.toBeNull();
      expect(before!.state, `${label}: startup switch state`).toMatch(/^(checked|unchecked)$/);
      expect(before!.width, `${label}: startup track width`).toBeGreaterThan(20);
      expect(before!.height, `${label}: startup track height`).toBeGreaterThan(12);
      expect(before!.backgroundColor, `${label}: startup track must be painted`).not.toBe('rgba(0, 0, 0, 0)');
      expect(before!.borderColor, `${label}: startup track border must be painted`).not.toBe('rgba(0, 0, 0, 0)');
      expect(before!.opacity, `${label}: startup track opacity`).toBeGreaterThan(0);
      expect(before!.thumbWidth, `${label}: startup thumb width`).toBeGreaterThan(8);
      expect(before!.thumbHeight, `${label}: startup thumb height`).toBeGreaterThan(8);
      expect(before!.thumbBackgroundColor, `${label}: startup thumb must be painted`).not.toBe('rgba(0, 0, 0, 0)');
      expect(before!.thumbOpacity, `${label}: startup thumb opacity`).toBeGreaterThan(0);

      await startupSwitch.click();
      await expect.poll(async () => (await readSwitchAppearanceViaCdp(mainWindow, 'startup-shortcut-enabled'))?.state).not.toBe(before!.state);
      const after = await readSwitchAppearanceViaCdp(mainWindow, 'startup-shortcut-enabled');
      expect(after, `${label}: toggled startup switch missing`).not.toBeNull();
      expect(after!.backgroundColor, `${label}: toggled track must be painted`).not.toBe('rgba(0, 0, 0, 0)');
      await expect.poll(async () => {
        const settled = await readSwitchAppearanceViaCdp(mainWindow, 'startup-shortcut-enabled');
        return settled ? Math.abs(settled.thumbOffsetX - before!.thumbOffsetX) : 0;
      }, { timeout: 1_000 }).toBeGreaterThan(2);

      await startupSwitch.click();
      await expect.poll(async () => (await readSwitchAppearanceViaCdp(mainWindow, 'startup-shortcut-enabled'))?.state).toBe(before!.state);
    }
    const apiKeyStatus = mainWindow.getByTestId('llm-tab:api-key-status');
    if (await apiKeyStatus.isVisible()) {
      await expect(apiKeyStatus).toBeVisible();
      await expectTestIdFullyVisibleViaCdp(mainWindow, 'llm-tab:api-key-status', `${label}: API key status`);
      const alignment = await apiKeyStatus.evaluate((status) => {
        const label = status.parentElement?.querySelector<HTMLElement>('[data-testid="llm-tab:api-key-label"]');
        if (!label) return { labelFound: false, topDelta: Number.POSITIVE_INFINITY };
        return { labelFound: true, topDelta: Math.abs(label.getBoundingClientRect().top - status.getBoundingClientRect().top) };
      });
      expect(alignment.labelFound, `${label}: API key label missing`).toBe(true);
      expect(alignment.topDelta, `${label}: API key status dropped below its label`).toBeLessThanOrEqual(1);

      const apiStatusMetrics = await readTestIdVisibilityViaCdp(mainWindow, 'llm-tab:api-key-status');
      const immediateMetrics = await readTestIdVisibilityViaCdp(mainWindow, 'llm-tab:immediate-badge');
      expect(immediateMetrics.length, `${label}: immediate badges missing`).toBeGreaterThanOrEqual(2);
      expect(immediateMetrics.every((metric) => Math.abs(metric.height - apiStatusMetrics[0]!.height) <= 1), `${label}: status badge heights diverge`).toBe(true);
    }

    const rulePattern = mainWindow.getByTestId('permissions-rule-pattern-input');
    if (await rulePattern.isVisible()) {
      await rulePattern.fill('batch_processing_audio_with_a_long_unbroken_identifier_for_mobile_layout');
      await mainWindow.getByTestId('permissions-rule-add').click();
      const rulesTable = mainWindow.getByTestId('permissions-rules-table');
      await expect(rulesTable).toBeVisible();
      const ruleMetrics = await rulesTable.evaluate((table) => {
        const container = table.parentElement;
        const cells = Array.from(table.querySelectorAll('tbody tr:first-child > td')).map((cell) => cell.getBoundingClientRect());
        return {
          clientWidth: container?.clientWidth ?? 0,
          scrollWidth: container?.scrollWidth ?? 0,
          overlap: cells.some((cell, index) => index > 0 && cell.left < cells[index - 1]!.right - 1),
          cellCount: cells.length,
        };
      });
      expect(ruleMetrics.scrollWidth, `${label}: rules table should keep readable column widths`).toBeGreaterThan(ruleMetrics.clientWidth);
      expect(ruleMetrics.cellCount, `${label}: rules table columns`).toBe(4);
      expect(ruleMetrics.overlap, `${label}: rules table cells overlap`).toBe(false);
    }

    const fallbackToggle = mainWindow.getByTestId('fallback-chain-toggle');
    if (await fallbackToggle.count()) {
      await fallbackToggle.click();
      await expect(fallbackToggle).toHaveAttribute('aria-expanded', 'true');
      await expectNoHorizontalOverflow(mainWindow, `${label}: fallback editor`);
    }

    if (await mainWindow.getByTestId('exec-mode-auto').count()) {
      await mainWindow.getByTestId('exec-mode-auto').click();
      const autoApprove = mainWindow.getByTestId('interactive-auto-approve-control');
      await expect(autoApprove).toBeVisible();
      await expectNoHorizontalOverflow(mainWindow, `${label}: auto-verify`);
      await expect(autoApprove.evaluate((element) => getComputedStyle(element).flexDirection)).resolves.toBe('column');
      await expect(autoApprove.getByTestId('interactive-auto-approve-select')).toHaveCSS('width', /px/);
    }

    await back.click();
    await expect(mainWindow.getByTestId('settings-mobile-list')).toBeVisible();
  }
});
