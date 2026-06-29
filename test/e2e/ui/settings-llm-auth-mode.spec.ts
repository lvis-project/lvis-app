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
  t,
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

  await settingsWindow.getByLabel(t('llmTab.authManual'), { exact: true }).check();
  await expect(manualSection).toBeVisible();
  await expect(loginSection).toHaveCount(0);

  await closeSettingsWindow(app, settingsWindow);
});

test('LLM tab: provider dropdown is searchable and scroll constrained', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'llm');

  await settingsWindow.locator('#vendor-select').click();

  const search = settingsWindow.getByTestId('llm-tab:vendor-search');
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute('placeholder', t('llmTab.vendorSearchPlaceholder'));
  await expect(settingsWindow.getByTestId('llm-tab:vendor-content')).toHaveClass(/max-h-\[386px\]/);

  await search.fill('openrouter');
  await expect(settingsWindow.getByRole('option', { name: 'OpenRouter' })).toBeVisible();
  await expect(settingsWindow.getByRole('option', { name: 'Google Gemini' })).toHaveCount(0);

  await closeSettingsWindow(app, settingsWindow);
});
