import { test, expect } from './fixtures';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';
import { TEST_IDS, execModeTestId } from "../../../src/shared/test-ids.js";

/**
 * Reviewer settings (single-axis redesign) — e2e smoke.
 *
 * The permission UI now exposes ONE axis: the exec-mode policy preset
 * (strict / default / auto / allow). The standalone reviewer-mode radio group
 * was removed — the LLM reviewer is implicit in the "auto" (자동 검증) mode.
 * Settings no longer exposes reviewer provider/model/fallback controls; auto
 * mode only shows the built-in reviewer prompt as a collapsed detail inside
 * the selected Auto-verify policy row.
 *
 * The render + IPC patterns are unit-tested in
 * `PermissionsTab.reviewer-c3.test.tsx` and `PermissionsTab.test.tsx`; this
 * guards the real Electron settings window render and the auto-gating behavior.
 */
test('reviewer prompt stays collapsed inside the auto-verification policy row', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');

  // Default policy preset → no reviewer config rendered, and the removed
  // standalone reviewer-mode radios must not exist.
  await expect(settingsPage.getByTestId(execModeTestId("auto"))).toBeVisible();
  await expect(settingsPage.getByTestId('reviewer-active-llm-source')).toHaveCount(0);
  await expect(settingsPage.getByTestId('reviewer-mode-llm')).toHaveCount(0);

  // Select 자동 검증 — only the read-only prompt collapse appears inside that row.
  await settingsPage.locator('#exec-mode-auto-radio').click();

  const autoRow = settingsPage.getByTestId(execModeTestId("auto"));
  await expect(autoRow.getByTestId(TEST_IDS.reviewerPromptPanel)).toBeVisible();
  await expect(settingsPage.getByTestId('reviewer-active-llm-source')).toHaveCount(0);
  await expect(settingsPage.getByTestId('reviewer-fallback-select')).toHaveCount(0);
  await expect(settingsPage.getByTestId('reviewer-framework-panel')).toHaveCount(0);
  await expect(settingsPage.getByText('검증 프롬프트')).toHaveCount(0);
  await autoRow.getByTestId(TEST_IDS.reviewerPromptPanel).locator('summary').click();
  await expect(autoRow.getByTestId('reviewer-system-prompt')).toContainText('UNTRUSTED_INPUT');
  // No standalone reviewer-mode radio override in the single-axis design.
  await expect(settingsPage.getByTestId('reviewer-mode-disabled')).toHaveCount(0);
  await expect(settingsPage.getByTestId('reviewer-mode-rule')).toHaveCount(0);
  await expect(settingsPage.getByTestId('reviewer-mode-llm')).toHaveCount(0);
  await expect(settingsPage.getByTestId('reviewer-mode-strict')).toHaveCount(0);

  await closeInlineSettings(app, settingsPage);
});

test('switching exec-mode away from auto hides the reviewer prompt collapse again', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'permissions');

  // Enter the auto-verification mode → prompt collapse visible.
  await settingsPage.locator('#exec-mode-auto-radio').click();
  await expect(settingsPage.getByTestId(execModeTestId("auto")).getByTestId(TEST_IDS.reviewerPromptPanel)).toBeVisible();

  // Switch to the default ("쓰기만 확인") preset → prompt collapse gone.
  await settingsPage.locator('#exec-mode-default-radio').click();
  await expect(settingsPage.getByTestId('reviewer-active-llm-source')).toHaveCount(0);
  await expect(settingsPage.getByTestId('reviewer-framework-panel')).toHaveCount(0);
  await expect(settingsPage.getByTestId(TEST_IDS.reviewerPromptPanel)).toHaveCount(0);

  await closeInlineSettings(app, settingsPage);
});
