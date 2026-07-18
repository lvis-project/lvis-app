import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';

/**
 * Settings is now an ALWAYS-INLINE panel (settings-inline-overhaul) — there is
 * no detached settings BrowserWindow in either app mode. These helpers keep the
 * legacy `openSettingsWindow(app, mainWindow) -> Page` / `closeSettingsWindow`
 * shape so the existing specs keep working, but the returned `Page` is the MAIN
 * window: settings renders inline inside it, and every `settingsWindow.getByX`
 * call in a spec now resolves against that same window.
 *
 * The inline shell is responsive — it flips to a narrow 2-depth stack (a
 * category list that drills into a detail pane) once the settings panel is
 * narrower than ~640px, which would hide the tab content behind the depth-1
 * list. The legacy specs expect the selected tab's content to be immediately
 * visible, so `openSettingsWindow` forces a WIDE content size before opening.
 * That makes the master-detail (both-regions-visible) layout deterministic
 * regardless of the headless display's work-area size. Specs that specifically
 * exercise the narrow/mobile shell drive the window size themselves (see
 * settings-responsive.spec.ts) and do not use this helper.
 */

const WIDE_CONTENT_WIDTH = 1200;
const WIDE_CONTENT_HEIGHT = 860;

/** Resize the largest visible app window (the main window) to a wide size. */
async function forceWideMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    if (target) target.setContentSize(size.w, size.h);
  }, { w: WIDE_CONTENT_WIDTH, h: WIDE_CONTENT_HEIGHT });
}

/**
 * Open the inline settings panel and return the main window. Routes through the
 * same `lvisApi.openSettingsWindow(tab)` IPC the app itself uses — which now
 * redirects to the inline panel (`activateInlineSettings`) rather than creating
 * a BrowserWindow.
 */
export async function openSettingsWindow(
  app: ElectronApplication,
  mainWindow: Page,
  initialTab = 'llm',
): Promise<Page> {
  await forceWideMainWindow(app);
  const result = await mainWindow.evaluate(async (tab) => {
    const api = (window as unknown as {
      lvisApi?: {
        openSettingsWindow?: (initialTab?: string) => Promise<{ ok: boolean; error?: string }>;
      };
    }).lvisApi;
    if (!api?.openSettingsWindow) {
      throw new Error('window.lvisApi.openSettingsWindow is not available');
    }
    return api.openSettingsWindow(tab);
  }, initialTab);

  if (!result?.ok) {
    throw new Error(result?.error ?? 'Failed to open inline settings');
  }

  // Locale-stable readiness gate: the sidebar heading only renders in the wide
  // master-detail layout (in narrow mode the sidebar is the depth-1 list).
  await expect(mainWindow.getByTestId('settings-sidebar-heading')).toBeVisible({ timeout: 15_000 });
  // The panel-width ResizeObserver may still be settling right after the resize;
  // wait until the shell has committed to the wide layout so tab content (not a
  // depth-1 category list) is what's on screen.
  await expect
    .poll(
      async () =>
        mainWindow.locator('[data-settings-layout]').getAttribute('data-settings-layout'),
      { timeout: 5_000 },
    )
    .toBe('wide');
  return mainWindow;
}

/**
 * "Close" the inline settings panel via its title-bar close button, which routes
 * to `onCloseSettings` (returns to the previously-active view). This unmounts
 * SettingsContent, so a subsequent `openSettingsWindow` remounts it and re-reads
 * persisted state — preserving the open→change→close→reopen persistence pattern
 * the detached window used to exercise.
 */
export async function closeSettingsWindow(
  _app: ElectronApplication,
  settingsWindow: Page,
): Promise<void> {
  await settingsWindow.getByTestId('settings-close').click();
  await expect(settingsWindow.getByTestId('settings-sidebar-heading')).toHaveCount(0, {
    timeout: 10_000,
  });
}
