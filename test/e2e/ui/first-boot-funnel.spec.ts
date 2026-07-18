/**
 * Cross-PR first-boot funnel e2e (#988 / #986).
 *
 * Each tutorial-track PR ships its own single-flow spec — ScenarioShowcase,
 * Live Auto-play, SpotlightTour — but none sequences the *combined*
 * first-boot funnel a real user walks. A regression where (e.g.) marking
 * onboarding complete silently dismisses the tour without firing
 * `markComplete` slips through all three per-PR specs. This spec closes
 * that gap end-to-end:
 *
 *   fresh LVIS_HOME →
 *     ScenarioShowcase →
 *     MemorySeed wizard → PersonalizedWelcome →
 *     SpotlightTour broadcasts "first-boot-essentials" and walks every step →
 *     `~/.lvis/onboarding/tour-state.json` lists "first-boot-essentials"
 *       in completedScenarios →
 *     reload → the tour does NOT auto-reopen.
 *
 * This spec opts out of the shared fixture returning-user seed with
 * `test.use({ onboardingCompleted: false })`, so the boot probe dispatches
 * `probe-start` and the Z onboarding chain mounts the ScenarioShowcase.
 */
import { test, expect } from './fixtures';
import path from 'node:path';
import fs from 'node:fs';

// This spec drives the no-key first-boot funnel (showcase → memory → tour).
// Opt out of the default seeded LLM key so the onboarding chain runs.
test.use({ onboardingCompleted: false, seedApiKey: false });

/** Read the persisted tour-state.json under the per-test LVIS_HOME. */
function readTourState(userDataDir: string): { completedScenarios?: string[] } | null {
  // The fixture sets LVIS_HOME to `${userDataDir}/lvis-state`; the
  // onboarding domain owns `~/.lvis/onboarding/tour-state.json`.
  const file = path.join(userDataDir, 'lvis-state', 'onboarding', 'tour-state.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

test.describe('first-boot funnel: onboarding → memory → tour completion', () => {
  test('walks the full chain, persists tour completion, and does not re-open the tour on reload', async ({
    mainWindow,
    userDataDir,
  }) => {
    // (1) Fresh boot → the Z chain mounts the ScenarioShowcase.
    const showcase = mainWindow.getByTestId('scenario-showcase');
    await expect(showcase).toBeVisible({ timeout: 30_000 });

    // (2) The scenario choice advances directly to MemorySeed. Model and key
    // configuration now live exclusively in Settings.
    await mainWindow.getByTestId('scenario-showcase:start').click();

    // (3) Fill 호칭 + 자기소개 and submit.
    const memoryDialog = mainWindow.getByTestId('memory-seed-dialog');
    await expect(memoryDialog).toBeVisible({ timeout: 15_000 });
    await memoryDialog.getByTestId('memory-seed-dialog:name').fill('Ken');
    await memoryDialog
      .getByTestId('memory-seed-dialog:intro')
      .fill('회의가 많은 PM. 회의록 정리와 일정 관리 자동화에 관심.');
    await memoryDialog.getByTestId('memory-seed-dialog:submit').click();
    await expect(memoryDialog).toBeHidden({ timeout: 10_000 });

    // (4) PersonalizedWelcome — forced choice. Pressing the only CTA
    // advances the chain to stage="tour", whose chain-effect broadcasts
    // `tour.start("first-boot-essentials")`.
    const welcome = mainWindow.getByTestId('personalized-welcome');
    await expect(welcome).toBeVisible({ timeout: 10_000 });
    await welcome.getByTestId('personalized-welcome:continue').click();
    await expect(welcome).toBeHidden({ timeout: 10_000 });

    // (5) SpotlightTour mounts on the broadcast and runs the first-boot
    // scenario against the live composer/action-bar anchors. The root
    // `spotlight-tour` div is a zero-size wrapper (its children — backdrop
    // + card — are position:fixed), so assert visibility on the card and
    // pin the scenario id on the attached root.
    const tour = mainWindow.getByTestId('spotlight-tour');
    const card = mainWindow.getByTestId('spotlight-tour:card');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(tour).toHaveAttribute('data-scenario-id', 'first-boot-essentials');

    // Walk every step: click "다음 →" until the final step's "완료" closes
    // the tour. The button label flips to "완료" on the last step; we drive
    // the next button until the tour card unmounts.
    const nextButton = mainWindow.getByTestId('spotlight-tour:next');
    // The first-boot scenario has a fixed step count; bound the loop well
    // above it so a regression that strands the tour fails loudly rather
    // than spinning forever.
    for (let step = 0; step < 12; step += 1) {
      if (!(await card.isVisible().catch(() => false))) break;
      await nextButton.click();
      // Allow the step transition (or close-out) to settle.
      await mainWindow.waitForTimeout(150);
    }
    await expect(card).toBeHidden({ timeout: 10_000 });

    // Installed plugins remain available from the persistent Marketplace and
    // Settings surfaces; onboarding no longer interrupts completion with a
    // second discovery popup.
    await expect(mainWindow.getByTestId('plugin-showcase')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          mainWindow.evaluate(async () => {
            const api = (window as unknown as {
              lvisApi: { getSettings: () => Promise<{ features?: { onboardingCompleted?: boolean } }> };
            }).lvisApi;
            const settings = await api.getSettings();
            return settings.features?.onboardingCompleted;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);

    // (6) Completion is persisted: tour-state.json must list the scenario
    // in completedScenarios (markComplete fired on the final step).
    await expect
      .poll(() => readTourState(userDataDir)?.completedScenarios ?? [], { timeout: 10_000 })
      .toContain('first-boot-essentials');

    // (7) Reload the app. The boot probe now sees onboardingCompleted=true
    // (the chain persisted it on stage="done"), so the chain skips and the
    // tour broadcast never fires — the tour must NOT auto-reopen.
    await mainWindow.reload();
    await mainWindow
      .locator('[data-testid="main-toolbar"]')
      .first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    // Give the boot probe + any chain effect time to run; the tour would
    // have re-broadcast within ~1s if the regression were present.
    await mainWindow.waitForTimeout(2_000);
    await expect(mainWindow.getByTestId('spotlight-tour')).toHaveCount(0);
    await expect(mainWindow.getByTestId('scenario-showcase')).toHaveCount(0);
  });
});
