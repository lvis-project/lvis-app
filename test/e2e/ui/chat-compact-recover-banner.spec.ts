import { test, expect } from './fixtures';

/**
 * #916 force-recover OFF-override banner + #917 recovery_exhausted banner.
 *
 * Uses app.evaluate to inject `lvis:chat:stream` events directly into the
 * renderer — the same channel the IPC layer uses — so the React state machine
 * is exercised without needing a real LLM connection.
 *
 * Coverage:
 *   B1 (#916): compact_started with triggerSource=force-recover shows a
 *      distinct "자동 압축을 끄셨지만" warning in the StatusBar.
 *   B2 (#916): compact_started with triggerSource=estimate shows the standard
 *      "자동 압축 중..." info label (no OFF-override text).
 *   B3 (#917): recovery_exhausted event shows a persistent "압축으로 복구 불가"
 *      error item in the StatusBar.
 *   B4 (#917): after recovery_exhausted, compact_started (normal) does NOT
 *      replace the error banner (StatusBar still shows error text).
 */

async function sendStreamEvent(
  app: import('@playwright/test').PlaywrightTestArgs['page'] extends never ? never : import('playwright').ElectronApplication,
  event: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    win.webContents.send('lvis:chat:stream', ev);
  }, event);
}

test.describe('compact recovery banners (#916 + #917)', () => {
  test('B1 (#916): force-recover compact_started shows OFF-override warning in StatusBar', async ({
    app,
    mainWindow,
    t,
  }) => {
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 15_000 });

    const composer = mainWindow.locator('[data-testid="composer"]').first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, {
      type: 'compact_started',
      triggerSource: 'force-recover',
      estimatedBefore: 90_000,
      preflight: 88_000,
    });

    // StatusBar should show the force-recover OFF-override message.
    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactForceRecoverValue'));

    // Cleanup: send compact_notice to clear indicator.
    await sendStreamEvent(app, {
      type: 'compact_notice',
      removedMessages: 5,
      freedTokens: 4_000,
    });
  });

  test('B2 (#916): normal compact_started shows standard 자동 압축 중 label (not OFF-override)', async ({
    app,
    mainWindow,
    t,
  }) => {
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 15_000 });

    const composer = mainWindow.locator('[data-testid="composer"]').first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, {
      type: 'compact_started',
      triggerSource: 'estimate',
      estimatedBefore: 90_000,
      preflight: 88_000,
    });

    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactInProgressValue'));

    const text = (await statusBar.textContent()) ?? '';
    expect(text).not.toContain(t('app.compactForceRecoverValue'));

    await sendStreamEvent(app, {
      type: 'compact_notice',
      removedMessages: 5,
      freedTokens: 4_000,
    });
  });

  test('B3 (#917): recovery_exhausted shows persistent 압축으로 복구 불가 error in StatusBar', async ({
    app,
    mainWindow,
    t,
  }) => {
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 15_000 });

    const composer = mainWindow.locator('[data-testid="composer"]').first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, { type: 'recovery_exhausted' });

    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactExhaustedValue'));
  });

  test('B4 (#917): recovery_exhausted banner persists; standard compact_started does not remove it', async ({
    app,
    mainWindow,
    t,
  }) => {
    const statusBar = mainWindow.locator('[data-testid="status-bar"]');
    await statusBar.waitFor({ state: 'visible', timeout: 15_000 });

    const composer = mainWindow.locator('[data-testid="composer"]').first();
    const booted = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!booted, 'Chat surface not booted.');

    await sendStreamEvent(app, { type: 'recovery_exhausted' });

    await expect
      .poll(
        async () => (await statusBar.textContent()) ?? '',
        { timeout: 8_000 },
      )
      .toContain(t('app.compactExhaustedValue'));

    // Subsequent normal compact cycle should NOT remove the exhausted banner.
    await sendStreamEvent(app, {
      type: 'compact_started',
      triggerSource: 'estimate',
      estimatedBefore: 90_000,
      preflight: 88_000,
    });
    await sendStreamEvent(app, {
      type: 'compact_notice',
      removedMessages: 3,
      freedTokens: 2_000,
    });

    const textAfterCompact = (await statusBar.textContent()) ?? '';
    expect(textAfterCompact).toContain(t('app.compactExhaustedValue'));
  });
});
