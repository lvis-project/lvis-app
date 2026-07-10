import { test, expect } from './fixtures';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

/**
 * Handshake-only OpenAI-compatible model list
 * (fix/llm-openai-compatible-model-handshake).
 *
 * The openai-compatible provider is endpoint-defined: its model dropdown must be
 * populated ONLY by a live /models handshake against the user-entered endpoint.
 * Before an address is entered there must be NO hardcoded seed — previously the
 * dropdown rendered the LVIS-cluster seed (Qwen3.6-.../Nemotron-...) pre-address,
 * and that fabricated default id was then sent to real endpoints (400/404).
 *
 * This spec pins the deterministic, network-free half: pre-address, the
 * openai-compatible model dropdown shows none of the former seed ids. The
 * populate-post-fetch half is covered by the jsdom LlmTab unit test (which stubs
 * the /models handshake) because a live handshake needs a real endpoint that the
 * headless e2e harness cannot provide deterministically.
 */
test('openai-compatible model dropdown shows no hardcoded seed before an endpoint is entered', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'llm');

  // Select the OpenAI-compatible provider from the searchable vendor dropdown.
  const vendorTrigger = settingsWindow.locator('#vendor-select');
  await expect(vendorTrigger).toBeVisible({ timeout: 10_000 });
  await vendorTrigger.click();
  const vendorSearch = settingsWindow.getByTestId('llm-tab:vendor-search');
  await expect(vendorSearch).toBeVisible();
  const compatLabel = t('constants.vendorOpenAiCompatibleLabel');
  await vendorSearch.fill(compatLabel);
  await settingsWindow.getByRole('option', { name: compatLabel }).click();

  // A fresh openai-compatible block ships with no base URL, so no /models
  // handshake runs and there is nothing to populate the dropdown with yet.
  const baseUrl = settingsWindow.getByTestId('llm-base-url-input');
  await expect(baseUrl).toHaveValue('');

  // Open the model dropdown: the former hardcoded LVIS-cluster seed must be gone.
  await settingsWindow.getByTestId('llm-model-select').click();
  await expect(settingsWindow.getByText('Qwen3.6-35B-A3B-NVFP4')).toHaveCount(0);
  await expect(settingsWindow.getByText('Nemotron-3-Nano-30B-A3B-FP8')).toHaveCount(0);

  await closeSettingsWindow(app, settingsWindow);
});
