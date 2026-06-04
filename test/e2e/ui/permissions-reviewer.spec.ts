import { test, expect } from './fixtures';
import { openSettingsWindow, closeSettingsWindow } from './settings-window';

/**
 * Reviewer settings (redesigned) — e2e smoke.
 *
 * Replaces the removed `permissions-reviewer-dropdown.spec.ts` (#768): the
 * per-provider reviewer dropdown (`reviewer-provider-select`, key-gated
 * foundry/gcp-playground options) was deleted when the reviewer provider became
 * managed centrally via the LLM/intelligence settings. The Permissions tab now
 * shows an active-LLM-source panel, a reviewer-mode radio group
 * (disabled/rule/llm/strict), an error-fallback Select, and an auto-approve
 * radio group.
 *
 * The render + IPC patterns are unit-tested in
 * `PermissionsTab.reviewer-c3.test.tsx`; this guards the real Electron settings
 * window render and a representative reviewer-mode interaction (the Radix
 * RadioGroup wired through `window.lvis.permission.reviewerDispatch`).
 */
test('reviewer section renders the redesigned controls', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

  // The redesigned reviewer surface (replaces the old provider dropdown).
  await expect(settingsWindow.getByTestId('reviewer-active-llm-source')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-mode-disabled')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-mode-rule')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-mode-llm')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-mode-strict')).toBeVisible();
  await expect(settingsWindow.getByTestId('reviewer-fallback-select')).toBeVisible();

  await closeSettingsWindow(app, settingsWindow);
});

test('selecting a reviewer mode switches the active radio', async ({ app, mainWindow }) => {
  const settingsWindow = await openSettingsWindow(app, mainWindow, 'permissions');

  // Click the Radix RadioGroupItem button directly (the wrapping <Label> does
  // not reliably toggle it).
  const strictRadio = settingsWindow.locator('#reviewer-mode-strict-radio');
  const ruleRadio = settingsWindow.locator('#reviewer-mode-rule-radio');

  // First select strict to establish a known pre-state (a no-op if strict is
  // already the default — which is fine, it is only setup). The strict→rule
  // transition below is the actual proof: it is a real switch in every case
  // (strict is checked before the rule click), and asserting strict flips to
  // unchecked can only pass if the RadioGroup → reviewerDispatch → re-render
  // cycle actually fired. Radix renders data-state checked|unchecked.
  await strictRadio.click();
  await ruleRadio.click();
  await expect(ruleRadio).toHaveAttribute('data-state', 'checked');
  await expect(strictRadio).toHaveAttribute('data-state', 'unchecked');

  await closeSettingsWindow(app, settingsWindow);
});
