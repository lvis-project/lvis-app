import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

/**
 * Corporate root CA controls — real-Electron round trip.
 *
 * Same reason as the hardware-acceleration spec next door, and more sharply:
 * these three values are read straight off the settings FILE at boot, before
 * `SettingsService` is constructed, because the certificate has to be in the
 * TLS trust store before the first outbound request. A control that persisted
 * only into the in-memory store would pass every unit test and still leave the
 * user with the state that made this work necessary — a setting they can see
 * and change that the next launch never reads.
 *
 * The name is also the first TEXT setting in this group, so it gets its own
 * check: typing is not persisting, and the commit path is what has to work.
 */
test('the two switches round-trip through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  for (const { testId, key } of [
    { testId: 'startup-corp-ca-enabled', key: 'corpCaEnabled' },
    { testId: 'startup-corp-ca-debug', key: 'corpCaDebugLog' },
  ] as const) {
    const toggle = settingsPage.getByTestId(testId);
    await expect(toggle).toBeVisible();
    // Nothing is forcing these in this harness, so the env notice stays absent.
    await expect(settingsPage.getByTestId(`${testId}-forced`)).toHaveCount(0);

    const before = await toggle.getAttribute('aria-checked');
    expect(before === 'true' || before === 'false').toBe(true);
    const expected = before !== 'true';

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(expected));

    await expect
      .poll(async () =>
        settingsPage.evaluate(async (settingKey) => {
          const api = (window as unknown as {
            lvisApi: { getSettings: () => Promise<unknown> };
          }).lvisApi;
          const settings = (await api.getSettings()) as {
            system?: Record<string, unknown>;
          };
          return settings.system?.[settingKey];
        }, key),
      )
      .toBe(expected);
  }

  // The help copy is unconditional — neither switch can affect this process.
  await expect(settingsPage.getByTestId('startup-corp-ca-help')).toBeVisible();
  await expect(settingsPage.getByTestId('startup-corp-ca-debug-help')).toBeVisible();

  await closeInlineSettings(app, settingsPage);
});

test('the certificate name persists only once it is committed', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'startup');

  // The switch above may have been left off by the previous test; the name
  // field is disabled while the feature is off, so make sure it is on first.
  const enabled = settingsPage.getByTestId('startup-corp-ca-enabled');
  if ((await enabled.getAttribute('aria-checked')) !== 'true') {
    await enabled.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'true');
  }

  const field = settingsPage.getByTestId('startup-corp-ca-common-name');
  await expect(field).toBeVisible();
  await expect(settingsPage.getByTestId('startup-corp-ca-common-name-help')).toBeVisible();
  await expect(settingsPage.getByTestId('startup-corp-ca-common-name-forced')).toHaveCount(0);

  const readName = async (): Promise<unknown> =>
    settingsPage.evaluate(async () => {
      const api = (window as unknown as {
        lvisApi: { getSettings: () => Promise<unknown> };
      }).lvisApi;
      const settings = (await api.getSettings()) as { system?: { corpCaCommonName?: string } };
      return settings.system?.corpCaCommonName;
    });

  const before = await readName();
  const expected = before === 'E2E Root CA' ? 'E2E Root CA 2' : 'E2E Root CA';

  await field.fill(expected);
  // Half-typed text must not reach the file the next launch reads, so nothing
  // is written until the commit below.
  expect(await readName()).toBe(before);

  await settingsPage.getByTestId('startup-corp-ca-common-name-save').click();
  await expect.poll(readName).toBe(expected);

  await closeInlineSettings(app, settingsPage);
});
