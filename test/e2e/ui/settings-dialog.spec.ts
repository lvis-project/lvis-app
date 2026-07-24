import { test, expect } from './fixtures';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

/**
 * Inline settings smoke (settings-inline-overhaul).
 *
 * Settings no longer detaches to its own BrowserWindow in any app mode — it is
 * an always-inline panel inside the main window. The old spec here asserted the
 * detached window's document title and that the *detached* window kept its own
 * Edit menu for copy/paste accelerators. Both are gone with the window:
 *   - there is no separate window title to assert;
 *   - copy/paste in settings inputs now rides the main window's application
 *     menu (Menu.setApplicationMenu carries {role:'copy'|'paste'}) plus
 *     Chromium's native input handling — a general main-window capability that
 *     every input-filling spec already exercises, not something specific to
 *     this surface.
 *
 * What remains worth pinning is that the inline panel opens to the requested
 * tab and that the title-bar close button exits it.
 */
test('inline settings opens to the requested tab and closes back', async ({ app, mainWindow, t }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'chat');

  // Scope to the settings panel — the main window's own sidebar has a "Chats"
  // tab whose accessible name would otherwise also match `name: 'Chat'` and
  // trip strict mode.
  const settingsPanel = settingsWindow.locator('[data-settings-layout]');
  await expect(
    settingsPanel.getByRole('tab', { name: t('settingsContent.tabChat'), exact: true }),
  ).toHaveAttribute('data-state', 'active');

  // Title-bar close leaves the settings view (the sidebar heading disappears).
  await closeSettingsWindow(app, settingsWindow);
});
