import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

/**
 * Shutdown cleanup window — real-Electron round trip.
 *
 * The unit tests cover the render, the parse, and the precedence. What they
 * cannot cover is whether the value the user picks reaches the settings
 * service the quit path actually reads: `runAppShutdownCleanup` asks
 * `settingsService.get('system')` for it as `before-quit` fires, so a control
 * that only moved renderer state would arm the same 15s deadline forever and
 * look correct in every unit test.
 *
 * The choice deliberately is NOT the default, so a pass cannot come from the
 * value that would have been there anyway.
 */
test('the cleanup window round-trips through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  const select = settingsPage.getByTestId('startup-shutdown-timeout');
  await expect(select).toBeVisible();
  await expect(settingsPage.getByTestId('startup-shutdown-timeout-help')).toBeVisible();
  // Nothing pins the variable in this harness, so the env notice must stay
  // absent and the control must stay usable.
  await expect(settingsPage.getByTestId('startup-shutdown-timeout-forced')).toHaveCount(0);
  await expect(select).toBeEnabled();

  await select.selectOption('30000');
  await expect(select).toHaveValue('30000');

  await expect
    .poll(async () =>
      settingsPage.evaluate(async () => {
        const api = (window as unknown as {
          lvisApi: { getSettings: () => Promise<unknown> };
        }).lvisApi;
        const settings = (await api.getSettings()) as {
          system?: { shutdownCleanupTimeoutMs?: number };
        };
        return settings.system?.shutdownCleanupTimeoutMs;
      }),
    )
    .toBe(30000);

  // Back to the shipped default: the control has to be able to offer it again,
  // which is the reason the option list is derived from the timeout policy.
  await select.selectOption('15000');
  await expect
    .poll(async () =>
      settingsPage.evaluate(async () => {
        const api = (window as unknown as {
          lvisApi: { getSettings: () => Promise<unknown> };
        }).lvisApi;
        const settings = (await api.getSettings()) as {
          system?: { shutdownCleanupTimeoutMs?: number };
        };
        return settings.system?.shutdownCleanupTimeoutMs;
      }),
    )
    .toBe(15000);

  await closeInlineSettings(app, settingsPage);
});
