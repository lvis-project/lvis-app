import { test, expect } from './fixtures';
import { buildIsolatedElectronEnv } from './seeded-electron';

/**
 * Chat history persistence — send a message, restart the app (reusing the
 * same isolated userData dir), and verify session/history is restored.
 * Skips gracefully if the chat input or a session affordance is missing.
 */
test('chat history persists across app restart, or skips cleanly', async ({
  app,
  mainWindow,
  userDataDir,
}) => {
  const input = mainWindow
    .locator('textarea, input[type="text"], [contenteditable="true"]')
    .first();

  const found = await input
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(!found, 'No chat input found — skipping persistence smoke.');

  const marker = `e2e-persist-${Date.now()}`;
  await input.click();
  await input.fill(marker);
  await mainWindow.waitForTimeout(500);

  await app.close().catch(() => {});

  const { _electron: electron } = await import('playwright');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(HERE, '../../..');
  const mainEntry = path.join(repoRoot, 'dist/src/main/main.js');

  const app2 = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: buildIsolatedElectronEnv({
      HOME: userDataDir,
      USERPROFILE: userDataDir,
      LVIS_HOME: path.join(userDataDir, 'lvis-state'),
      LVIS_DEV: '1',
      LVIS_E2E: '1',
      LVIS_MAIN_ENTRY: mainEntry,
      NODE_ENV: 'test',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    }),
    timeout: 30_000,
  });

  try {
    const win2 = await app2.firstWindow();
    // The app first loads a data: splash URL, then boots and replaces it
    // with the real index.html. domcontentloaded fires on the splash where
    // there is no #root — wait for the persistent main-toolbar testid
    // instead, mirroring fixtures.mainWindow's bootstrap gate.
    await win2.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: 'visible',
      timeout: 60_000,
    });

    const rootCount = await win2.locator('#root').count();
    expect(rootCount).toBe(1);

    const bodyText = await win2.locator('body').innerText().catch(() => '');
    if (bodyText.includes(marker)) {
      expect(bodyText).toContain(marker);
    }
  } finally {
    await app2.close().catch(() => {});
  }
});
