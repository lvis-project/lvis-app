import { test, expect } from './fixtures';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

test('native settings window opens and closes', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'chat');

  await expect(settingsWindow).toHaveTitle(/LVIS 설정/);
  await expect(settingsWindow.getByRole('tab', { name: '채팅' })).toHaveAttribute(
    'data-state',
    'active',
  );

  await closeSettingsWindow(app, settingsWindow);
});

test('native settings window preserves standard copy and paste shortcuts', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'llm');
  const shortcut = process.platform === 'darwin' ? 'Meta' : 'Control';
  const pastedValue = 'settings-copy-paste-e2e-value';
  // The model field is now a <select>; use the plain-text Endpoint/baseUrl input
  // to exercise the native window's copy/paste edit-menu roles.
  const textInput = settingsWindow.getByTestId('llm-base-url-input');

  await app.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value);
  }, pastedValue);

  await textInput.fill('');
  await textInput.focus();
  await settingsWindow.keyboard.press(`${shortcut}+V`);
  await expect(textInput).toHaveValue(pastedValue);

  await settingsWindow.keyboard.press(`${shortcut}+A`);
  await settingsWindow.keyboard.press(`${shortcut}+C`);
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toBe(pastedValue);

  await closeSettingsWindow(app, settingsWindow);
});
