import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';

/**
 * Away Authority's desk gesture, in the real window.
 *
 * The renderer unit tests cover the dialog's logic — mode switching, the write
 * acknowledgement, the disclosure copy — by mounting the component with a
 * snapshot that already has a share. What they cannot cover is the composition
 * one level up: that on a desktop with no Telegram share, the arming control is
 * not rendered at all.
 *
 * That is the property worth an end-to-end assertion, because it is the one a
 * unit test structurally cannot make. A grant is a statement about one
 * particular share; with no share there is nothing to bound it to, so the
 * control is withheld rather than shown-and-disabled. Mounting
 * `AwayAuthorityContent` directly proves nothing about whether its parent
 * decided to mount it, and that decision is the whole guard.
 *
 * No Telegram bot, token, or network is involved. The unshared state is the
 * app's default and is exactly the state under test.
 */
test('renders no away-authority control while nothing is shared', async ({
  app,
  mainWindow,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'remote-surfaces');

  // Non-vacuous anchor: the tab really did render, so the absences below are
  // about the guard and not about a pane that never loaded.
  await expect(settingsPage.getByTestId('telegram-connection-content')).toBeVisible();
  await expect(settingsPage.getByTestId('telegram-connection-connect')).toBeVisible();

  // The whole surface is withheld — not the button alone. A disabled control
  // would still tell a reader that arming is a thing this desktop can do, and
  // would be one regression away from being enabled with no share behind it.
  await expect(settingsPage.getByTestId('away-authority-content')).toHaveCount(0);
  await expect(settingsPage.getByTestId('away-authority-open-arm-dialog')).toHaveCount(0);
  await expect(settingsPage.getByTestId('away-authority-arm-dialog')).toHaveCount(0);
  await expect(settingsPage.getByTestId('away-authority-disarm')).toHaveCount(0);

  await closeInlineSettings(app, settingsPage);
});

/**
 * The Remote Surfaces tab is where all of this lives, so it has to actually be
 * reachable by its id. `settings-tabs.ts` renamed this tab from `tailnet-access`
 * and kept an alias; a spec that navigated only by the old name would keep
 * passing while the new one broke, and vice versa.
 */
test('reaches the remote surfaces tab by its current id', async ({
  app,
  mainWindow,
  t,
}) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'remote-surfaces');

  const panel = settingsPage.locator('[data-settings-layout]');
  await expect(
    panel.getByRole('tab', { name: t('settingsContent.tabRemoteSurfaces'), exact: true }),
  ).toHaveAttribute('data-state', 'active');

  await closeInlineSettings(app, settingsPage);
});
