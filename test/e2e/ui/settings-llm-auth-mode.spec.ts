import { test, expect } from './fixtures';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

/**
 * #893 — Top-level auth-mode toggle Playwright E2E.
 *
 * Validates that `llm-tab:auth-mode` correctly wraps the entire 공급자 구성
 * region (vendor dropdown + endpoint + API key + model + vertex fields)
 * under a single login toggle, per the demo-login epic:
 *   - authMode=manual renders llm-tab:manual-section (vendor + per-vendor form)
 *   - authMode=login renders llm-tab:login-section (status + Login button) and
 *     the entire manual form is removed from the DOM
 *   - llm-tab:open-login button is reachable in login mode
 *   - Toggling back to manual restores the form
 *
 * The component-level unit test (LlmTab.top-level-login.test.tsx) already
 * verifies the DOM toggling logic with a fully mocked api shape; this spec
 * exercises the same contract against the real Electron renderer so the
 * settings IPC wiring + persistence path are covered end-to-end.
 */
test('LLM tab: authMode toggle wraps provider configuration under login', async ({
  app,
  mainWindow,
}) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'llm');

  const authMode = settingsWindow.getByTestId('llm-tab:auth-mode');
  await expect(authMode).toBeVisible();

  const manualSection = settingsWindow.getByTestId('llm-tab:manual-section');
  const loginSection = settingsWindow.getByTestId('llm-tab:login-section');

  await expect(manualSection).toBeVisible();
  await expect(loginSection).toHaveCount(0);

  await settingsWindow.getByLabel('Login', { exact: true }).check();

  await expect(loginSection).toBeVisible();
  await expect(manualSection).toHaveCount(0);
  await expect(settingsWindow.getByTestId('llm-tab:open-login')).toBeVisible();

  await settingsWindow.getByLabel('API 키 직접 입력', { exact: true }).check();
  await expect(manualSection).toBeVisible();
  await expect(loginSection).toHaveCount(0);

  await closeSettingsWindow(app, settingsWindow);
});
