import { test, expect } from './fixtures';
import { openSettingsWindow, closeSettingsWindow } from './settings-window';

/**
 * Reviewer settings (single-axis redesign) — e2e smoke.
 *
 * The permission UI now exposes ONE axis: the exec-mode policy preset
 * (strict / default / auto / allow). The standalone reviewer-mode radio group
 * was removed — the LLM reviewer is implicit in the "auto" (자동 검증) mode,
 * which auto-wires the reviewer to LLM. The reviewer config surface
 * (active-LLM-source panel, error-fallback Select, framework panel) therefore
 * only renders when the auto-verification mode is selected.
 *
 * The render + IPC patterns are unit-tested in
 * `PermissionsTab.reviewer-c3.test.tsx` and `PermissionsTab.test.tsx`; this
 * guards the real Electron settings window render and the auto-gating behavior.
 */
test('reviewer section is hidden until the auto-verification mode is selected', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

  // Default policy preset → no reviewer config rendered, and the removed
  // standalone reviewer-mode radios must not exist.
  await expect(settingsWindow.getByTestId('exec-mode-auto')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-active-llm-source')).toHaveCount(0);
  await expect(settingsWindow.getByTestId('reviewer-mode-llm')).toHaveCount(0);

  // Select 자동 검증 — the reviewer config (auto-wired to LLM) appears.
  await settingsWindow.locator('#exec-mode-auto-radio').click();

  await expect(settingsWindow.getByTestId('reviewer-active-llm-source')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-fallback-select')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-framework-panel')).toBeVisible();
  // No standalone reviewer-mode radio override in the single-axis design.
  await expect(settingsWindow.getByTestId('reviewer-mode-disabled')).toHaveCount(0);
  await expect(settingsWindow.getByTestId('reviewer-mode-rule')).toHaveCount(0);
  await expect(settingsWindow.getByTestId('reviewer-mode-llm')).toHaveCount(0);
  await expect(settingsWindow.getByTestId('reviewer-mode-strict')).toHaveCount(0);

  await closeSettingsWindow(app, settingsWindow);
});

test('switching exec-mode away from auto hides the reviewer config again', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

  // Enter the auto-verification mode → reviewer config visible.
  await settingsWindow.locator('#exec-mode-auto-radio').click();
  await expect(settingsWindow.getByTestId('reviewer-active-llm-source')).toBeVisible();

  // Switch to the default ("쓰기만 확인") preset → reviewer config gone.
  await settingsWindow.locator('#exec-mode-default-radio').click();
  await expect(settingsWindow.getByTestId('reviewer-active-llm-source')).toHaveCount(0);
  await expect(settingsWindow.getByTestId('reviewer-framework-panel')).toHaveCount(0);

  await closeSettingsWindow(app, settingsWindow);
});
