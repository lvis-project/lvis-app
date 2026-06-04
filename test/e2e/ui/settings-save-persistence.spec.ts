import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';
import { openSettingsWindow } from './settings-window';

/**
 * Settings save + reload persistence through the native settings BrowserWindow.
 *
 * Post PR #780 semantics:
 *   - Toggle / Checkbox / Radio / Select / Slider controls are
 *     immediate-apply (200ms debounced). The PII redact checkbox in
 *     ChatTab fires `s.save("chat")` after the user flips it; the user
 *     does NOT need to click an explicit Save button.
 *   - The dialog/window does NOT auto-close on save — the multi-tab
 *     Settings modal pattern keeps the surface open so users can verify
 *     and edit a sibling tab. Close lives on the window's X / Esc.
 *
 * This spec exercises that flow: flip the toggle → wait for the
 * debounced auto-save → assert the settings file reflects the change
 * → manually close the window → reopen → assert the toggle reads the
 * persisted state on rehydrate.
 */
test('immediate-apply toggle persists privacy redaction without explicit Save', async ({
  app,
  mainWindow,
  userDataDir,
  t,
}) => {
  const settingsPath = path.join(userDataDir, 'lvis-settings.json');
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'chat');
  const redactToggle = settingsWindow.getByRole('checkbox', {
    name: t('privacyTab.piiRedactToggleLabel'),
  });

  await expect(redactToggle).toBeVisible({ timeout: 10_000 });
  if ((await redactToggle.getAttribute('aria-checked')) !== 'true') {
    await redactToggle.click();
  }
  await expect(redactToggle).toHaveAttribute('aria-checked', 'true');

  // No Save button click — immediate-apply via the 200ms debounced
  // auto-save path that PR #780 wired up. Poll the settings file until
  // it reflects the new value; budget covers debounce + IPC round-trip.
  await expect
    .poll(
      () => {
        try {
          const raw = fs.readFileSync(settingsPath, 'utf-8');
          return JSON.parse(raw)?.privacy?.piiRedactEnabled;
        } catch {
          return undefined;
        }
      },
      { timeout: 5_000, intervals: [200, 400, 800] },
    )
    .toBe(true);

  // PR #780 design: save does NOT close the window. Close manually
  // before reopen so the rehydrate assertion sees a fresh mount.
  await settingsWindow.close();

  const reopenedSettingsWindow = await openSettingsWindow(app, mainWindow, 'chat');
  await expect(
    reopenedSettingsWindow.getByRole('checkbox', {
      name: t('privacyTab.piiRedactToggleLabel'),
    }),
  ).toHaveAttribute('aria-checked', 'true');
  await reopenedSettingsWindow.close();
});
