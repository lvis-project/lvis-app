import { test, expect } from './fixtures';
import { openSettingsWindow } from './settings-window';

test('native settings window opens and closes', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'chat');

  await expect(settingsWindow).toHaveTitle(/LVIS 설정/);
  await expect(settingsWindow.getByRole('tab', { name: '채팅' })).toHaveAttribute(
    'data-state',
    'active',
  );

  const closePromise = settingsWindow.waitForEvent('close');
  await settingsWindow.getByRole('button', { name: '닫기' }).click();
  await closePromise;
});
