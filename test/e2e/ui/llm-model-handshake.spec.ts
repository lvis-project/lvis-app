import { test, expect } from './fixtures';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';
import { TEST_IDS } from "../../../src/shared/test-ids.js";

/**
 * Handshake-only OpenAI-compatible model list.
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
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  // Providers are a list of cards now, not a vendor dropdown: an unconfigured
  // provider is reached through "add a provider", which reveals its card and
  // opens the credential form on it.
  await settingsPage.getByTestId('llm-tab:add-provider').click();
  await settingsPage.getByTestId('llm-tab:add-provider-item:openai-compatible').click();

  // A fresh openai-compatible block ships with no base URL, so no /models
  // handshake runs and there is nothing to populate the dropdown with yet.
  const baseUrl = settingsPage.getByTestId('llm-base-url-input');
  await expect(baseUrl).toBeVisible({ timeout: 10_000 });
  await expect(baseUrl).toHaveValue('');

  // Open the model dropdown: the former hardcoded LVIS-cluster seed must be gone.
  await settingsPage.getByTestId(TEST_IDS.llmModelSelect).click();
  await expect(settingsPage.getByText('Qwen3.6-35B-A3B-NVFP4')).toHaveCount(0);
  await expect(settingsPage.getByText('Nemotron-3-Nano-30B-A3B-FP8')).toHaveCount(0);

  // Dismiss the open Select popover before leaving — its overlay would
  // otherwise intercept the settings Back-button click during teardown.
  await settingsPage.keyboard.press('Escape');
  await closeInlineSettings(app, settingsPage);
});
