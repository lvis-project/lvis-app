import { test, expect } from './fixtures';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

/**
 * Tutorial-A — Login modal variant toggle e2e.
 *
 * Verifies the user-visible loop end-to-end:
 *   1. Default variant is "conversational" — the modal renders with
 *      `data-variant="conversational"` on first boot.
 *   2. Flipping the radio in Settings → 채팅 → 로그인 화면 스타일 to
 *      "cli-agent" remounts the modal with `data-variant="cli-agent"`
 *      without an app restart (live `loginPrefsChanged` IPC broadcast).
 *   3. The flip persists across the same session: closing + re-opening
 *      the modal lands on the chosen variant.
 *
 * Demo credentials are seeded so the LoginModal in LLM tab can actually
 * be opened from `llm-tab:open-login`. We never submit the form — only
 * inspect `data-variant` on the dialog content node.
 */

const DEMO_KEY = 'sk-e2e-login-variant-openai';

test.use({
  launchEnv: {
    LVIS_DEMO_ENABLED: '1',
    LVIS_DEMO_VENDOR: 'openai',
    LVIS_DEMO_KEY_OPENAI: DEMO_KEY,
    LVIS_WHITELIST_OFFLINE: '1',
  },
});

test('Login modal variant toggle persists and remounts across opens', async ({
  app,
  mainWindow,
}) => {
  await mainWindow.evaluate(async () => {
    const api = (
      window as unknown as {
        lvisApi: { updateSettings: (patch: unknown) => Promise<unknown> };
      }
    ).lvisApi;
    await api.updateSettings({ llm: { authMode: 'login', provider: 'openai' } });
  });

  // ─── 1. Default variant: conversational ─────────────────────────
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'llm');
  await settingsWindow.getByTestId('llm-tab:open-login').click();
  const modal1 = settingsWindow.getByTestId('login-modal');
  await expect(modal1).toBeVisible();
  await expect(modal1).toHaveAttribute('data-variant', 'conversational');
  // Close the modal — press Escape so the dialog overlay tears down cleanly.
  await settingsWindow.keyboard.press('Escape');
  await expect(modal1).toHaveCount(0);

  // ─── 2. Flip the radio in Chat tab → CLI Agent ─────────────────
  await settingsWindow.getByRole('tab', { name: '채팅' }).click();
  await settingsWindow
    .getByTestId('settings:login-variant:cli-agent')
    .check();

  // ─── 3. Reopen the modal — should now render cli-agent ─────────
  await settingsWindow.getByRole('tab', { name: '모델' }).click();
  await settingsWindow.getByTestId('llm-tab:open-login').click();
  const modal2 = settingsWindow.getByTestId('login-modal');
  await expect(modal2).toBeVisible();
  await expect(modal2).toHaveAttribute('data-variant', 'cli-agent');

  await closeSettingsWindow(settingsWindow);
});
