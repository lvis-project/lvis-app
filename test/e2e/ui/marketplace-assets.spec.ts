import { test, expect } from './fixtures';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

test('settings marketplace assets expand provider, theme, and language pickers', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'llm');

  const llmTab = settingsWindow.getByRole('tab', { name: t('settingsContent.tabLlm') });
  const appearanceTab = settingsWindow.getByRole('tab', {
    name: t('settingsContent.tabAppearance'),
  });
  const marketplaceTab = settingsWindow.getByRole('tab', {
    name: t('settingsContent.tabMarketplace'),
  });

  await settingsWindow.locator('#vendor-select').click();
  await settingsWindow.getByTestId('llm-tab:vendor-search').fill('groq');
  await expect(settingsWindow.getByRole('option', { name: /Groq/i })).toHaveCount(0);
  await settingsWindow.keyboard.press('Escape');

  await settingsWindow.getByTestId('llm-tab:marketplace-providers').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');

  const providerAction = settingsWindow.getByTestId('marketplace:action:provider-groq');
  await expect(providerAction).toBeVisible();
  await providerAction.click();
  await expect(providerAction).toContainText(t('marketplaceTab.removeButton'));

  await llmTab.click();
  await settingsWindow.locator('#vendor-select').click();
  await settingsWindow.getByTestId('llm-tab:vendor-search').fill('groq');
  await settingsWindow.getByRole('option', { name: /Groq/i }).click();
  await expect(settingsWindow.getByTestId('llm-tab:selected-provider-marketplace:groq'))
    .toBeVisible();

  await appearanceTab.click();
  await expect(settingsWindow.locator('[data-bundle-id="tokyo-night"]')).toHaveCount(0);
  await expect(settingsWindow.getByTestId('language-option-ko')).toHaveCount(0);

  await settingsWindow.getByTestId('appearance-tab:marketplace-themes').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  const themeAction = settingsWindow.getByTestId('marketplace:action:theme-tokyo-night');
  await expect(themeAction).toBeVisible();
  await themeAction.click();
  await expect(themeAction).toContainText(t('marketplaceTab.removeButton'));

  await appearanceTab.click();
  await expect(settingsWindow.locator('[data-bundle-id="tokyo-night"]')).toBeVisible();
  await expect(settingsWindow.getByTestId('appearance-tab:theme-marketplace-badge:tokyo-night'))
    .toBeVisible();

  await settingsWindow.getByTestId('appearance-tab:marketplace-languages').click();
  await expect(marketplaceTab).toHaveAttribute('data-state', 'active');
  const languageAction = settingsWindow.getByTestId('marketplace:action:language-ko');
  await expect(languageAction).toBeVisible();
  await languageAction.click();
  await expect(languageAction).toContainText(t('marketplaceTab.removeButton'));

  await appearanceTab.click();
  await expect(settingsWindow.getByTestId('language-option-ko')).toBeVisible();
  await expect(settingsWindow.getByTestId('appearance-tab:language-marketplace-badge:ko'))
    .toBeVisible();

  await closeSettingsWindow(app, settingsWindow);
});
