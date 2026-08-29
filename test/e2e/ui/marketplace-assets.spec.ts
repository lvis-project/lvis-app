import { test, expect } from './fixtures';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

test('settings marketplace assets expand provider, theme, and language pickers', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  const llmTab = settingsPage.getByRole('tab', { name: t('settingsContent.tabLlm') });
  const appearanceTab = settingsPage.getByRole('tab', {
    name: t('settingsContent.tabAppearance'),
  });
  const marketplaceTab = settingsPage.getByRole('tab', {
    name: t('settingsContent.tabMarketplace'),
  });

  // A built-in provider is already on the page (the fixture seeds a key for
  // every vendor, so its row is configured at boot). Anchoring on it first
  // means the absence check below cannot pass by the tab never having
  // rendered.
  await expect(settingsPage.getByTestId('llm-tab:connection:claude')).toBeVisible();
  await expect(settingsPage.getByTestId('llm-tab:connection:groq')).toHaveCount(0);

  await settingsPage.getByTestId('llm-tab:marketplace-providers').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');

  const providerAction = settingsPage.getByTestId('marketplace:action:provider-groq');
  await expect(providerAction).toBeVisible();
  await providerAction.click();
  await expect(providerAction).toContainText(t('marketplaceTab.removeButton'));

  await llmTab.click();
  // Installing the provider puts it in the vendor catalogue, so its seeded key
  // is now probed and it earns a row of its own, badged as marketplace-sourced.
  await expect(settingsPage.getByTestId('llm-tab:connection:groq')).toBeVisible();
  await expect(settingsPage.getByTestId('llm-tab:selected-provider-marketplace:groq'))
    .toBeVisible();

  await appearanceTab.click();
  await expect(settingsPage.locator('[data-bundle-id="tokyo-night"]')).toHaveCount(0);
  await expect(settingsPage.getByTestId('language-option-ko')).toHaveCount(0);

  await settingsPage.getByTestId('appearance-tab:marketplace-themes').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  const themeAction = settingsPage.getByTestId('marketplace:action:theme-tokyo-night');
  await expect(themeAction).toBeVisible();
  await themeAction.click();
  await expect(themeAction).toContainText(t('marketplaceTab.removeButton'));

  await appearanceTab.click();
  await expect(settingsPage.locator('[data-bundle-id="tokyo-night"]')).toBeVisible();
  await expect(settingsPage.getByTestId('appearance-tab:theme-marketplace-badge:tokyo-night'))
    .toBeVisible();

  await settingsPage.getByTestId('appearance-tab:marketplace-languages').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  const languageAction = settingsPage.getByTestId('marketplace:action:language-ko');
  await expect(languageAction).toBeVisible();
  await languageAction.click();
  await expect(languageAction).toContainText(t('marketplaceTab.removeButton'));

  await appearanceTab.click();
  await expect(settingsPage.getByTestId('language-option-ko')).toBeVisible();
  await expect(settingsPage.getByTestId('appearance-tab:language-marketplace-badge:ko'))
    .toBeVisible();

  await closeInlineSettings(app, settingsPage);
});
