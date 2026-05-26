import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

/**
 * Coverage for the demo display toggle (`features.hideToolFailures`).
 *
 * The toggle persisted correctly but, as a purely-controlled Switch, only
 * moved once the updateSettings → onSettingsUpdated broadcast round-tripped
 * back into `settings` — so a stale/slow snapshot left it visually stuck while
 * the value still persisted. It is now optimistic (flips on the click itself).
 *
 * Guards:
 *  - the Switch flips quickly on click (optimistic — a near-instant budget so a
 *    regression back to broadcast-gated control is more likely to be caught),
 *  - the value persists,
 *  - a freshly opened settings window reflects the persisted state on load
 *    (mount-time reflection — the property behind the "shows OFF while the
 *    setting is true" report).
 */
async function readPersisted(win: Page): Promise<boolean> {
  return win.evaluate(async () => {
    const api = (window as unknown as {
      lvisApi: { getSettings: () => Promise<{ features?: { hideToolFailures?: boolean } }> };
    }).lvisApi;
    return (await api.getSettings()).features?.hideToolFailures === true;
  });
}

test('General tab: 데모 표시 toggle flips, persists, and reflects on reopen', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'general');

  const toggle = settingsWindow.getByTestId('general-tab-hide-tool-failures');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // Optimistic flip: the Switch must reflect the click on a tight budget,
  // independent of the persistence round-trip.
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 1_000 });
  await expect.poll(() => readPersisted(settingsWindow), { timeout: 10_000 }).toBe(true);

  // Reopen the settings window — the Switch must reflect the persisted ON
  // state on load.
  await closeSettingsWindow(app, settingsWindow);
  const reopened = await openSettingsWindow(app, mainWindow, 'general');
  const reToggle = reopened.getByTestId('general-tab-hide-tool-failures');
  await expect(reToggle).toBeChecked();

  // Toggle back off + verify, leaving persisted state clean.
  await reToggle.click();
  await expect(reToggle).not.toBeChecked({ timeout: 1_000 });
  await expect.poll(() => readPersisted(reopened), { timeout: 10_000 }).toBe(false);

  await closeSettingsWindow(app, reopened);
});
