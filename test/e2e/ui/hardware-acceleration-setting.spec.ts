import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

/**
 * Hardware-acceleration control — real-Electron round trip.
 *
 * The unit tests cover the render and the resolver. What they cannot cover is
 * the part that made this variable worth surfacing at all: the toggle has to
 * reach the settings FILE, because the next launch reads that file directly
 * before `SettingsService` exists. A control that persisted only into the
 * in-memory store would look correct in every unit test and change nothing
 * about how the app starts.
 *
 * So this drives the real toggle and then asks the main process what it has —
 * `getSettings()` reads through the same service that writes the file.
 */
test('the toggle round-trips through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  const toggle = settingsPage.getByTestId('startup-hardware-acceleration');
  await expect(toggle).toBeVisible();
  // The copy is unconditional: nothing here can affect the running process.
  await expect(settingsPage.getByTestId('startup-hardware-acceleration-help')).toBeVisible();
  // Nothing is forcing it in this harness, so the env notice must stay absent.
  await expect(settingsPage.getByTestId('startup-hardware-acceleration-forced')).toHaveCount(0);

  const before = await toggle.getAttribute('aria-checked');
  expect(before === 'true' || before === 'false').toBe(true);
  const expected = before !== 'true';

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(expected));

  await expect
    .poll(async () =>
      settingsPage.evaluate(async () => {
        const api = (window as unknown as {
          lvisApi: { getSettings: () => Promise<unknown> };
        }).lvisApi;
        const settings = (await api.getSettings()) as {
          system?: { hardwareAcceleration?: boolean };
        };
        return settings.system?.hardwareAcceleration;
      }),
    )
    .toBe(expected);

  await closeInlineSettings(app, settingsPage);
});
