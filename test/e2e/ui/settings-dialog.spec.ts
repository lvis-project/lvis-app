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
  const pastedModel = 'settings-copy-paste-e2e-model';
  const modelInput = settingsWindow.getByTestId('llm-model-input');

  await app.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value);
  }, pastedModel);

  await modelInput.fill('');
  await modelInput.focus();
  await settingsWindow.keyboard.press(`${shortcut}+V`);
  await expect(modelInput).toHaveValue(pastedModel);

  await settingsWindow.keyboard.press(`${shortcut}+A`);
  await settingsWindow.keyboard.press(`${shortcut}+C`);
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toBe(pastedModel);

  await closeSettingsWindow(app, settingsWindow);
});
