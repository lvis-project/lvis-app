import { test, expect } from './fixtures';

/**
 * English-default boot smoke.
 *
 * The rest of the e2e suite seeds `appearance.language: "ko"` (the specs assert
 * the Korean catalog). Production, however, defaults to English after #1200
 * (DEFAULT_LOCALE = "en"), so without this spec the suite would never exercise
 * the English catalog or the default boot path — exactly the gap that let the
 * i18n default-flip break e2e unnoticed.
 *
 * This spec overrides the locale seed to "en" and asserts the renderer actually
 * resolves and renders the English catalog. Kept deliberately small (the Korean
 * specs cover behavior; this only guards the English render path).
 */
test.use({ seedLocale: 'en' });

test('boots in English: composer placeholder renders the English catalog', async ({ mainWindow }) => {
  const textarea = mainWindow.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 10_000 });

  const placeholder = await textarea.getAttribute('placeholder');

  // English `composerPlaceholder.defaultHint` — proves the en catalog resolved
  // (the ko default hint starts with "질문 입력").
  expect(placeholder).toContain('Type a message');
  expect(placeholder).not.toContain('질문 입력');
});

test('boots in English: settings window heading is "Settings"', async ({ app, mainWindow }) => {
  // Open the settings window directly (the shared openSettingsWindow helper
  // waits on the Korean "설정" heading, so it is intentionally not used here).
  const settingsWindowPromise = app.waitForEvent('window', { timeout: 10_000 });
  await mainWindow.evaluate(async () => {
    const api = (window as unknown as {
      lvisApi: { openSettingsWindow: (tab: string) => Promise<unknown> };
    }).lvisApi;
    await api.openSettingsWindow('llm');
  });
  const settingsWindow = await settingsWindowPromise;
  await settingsWindow.waitForLoadState('domcontentloaded');

  await expect(
    settingsWindow.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    settingsWindow.getByRole('heading', { name: '설정', exact: true }),
  ).toHaveCount(0);
});
