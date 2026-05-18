import { test, expect } from './fixtures';

/**
 * Tutorial-D — Discovery Swipe e2e.
 *
 * Verifies the user-visible loop end-to-end:
 *   1. Open the dialog via the renderer-side `tutorialOpen()` IPC
 *      (matches the Help menu + chat context menu trigger path).
 *   2. Swipe through all 5 cards (mixing ✓ / ✕ / skip).
 *   3. The "추천 완료" summary appears with the chosen scenarios.
 *   4. `tutorialTourStart` is invoked exactly once with the first
 *      liked card's `spotlightScenarioId`.
 *
 * The test stubs `window.lvisApi.tutorialTourStart` so we observe the
 * dispatch without depending on PR-C's Spotlight engine.
 */

test.use({
  launchEnv: {
    LVIS_DEMO_ENABLED: '1',
    LVIS_WHITELIST_OFFLINE: '1',
  },
});

test('Discovery Swipe deck records likes/dislikes and dispatches the first liked scenario tour', async ({
  mainWindow,
}) => {
  // Install a stub on lvisApi.tour.start that records calls so the test
  // can inspect the dispatched scenario without depending on PR-C's
  // Spotlight engine actually mounting a tour.
  await mainWindow.evaluate(() => {
    interface Stubbed {
      lvisApi: {
        tour: { start: (scenarioId: string) => Promise<{ ok: true }> };
      };
      __lvisTutorialTourCalls: { scenarioId: string }[];
    }
    const w = window as unknown as Stubbed;
    w.__lvisTutorialTourCalls = [];
    const original = w.lvisApi.tour.start;
    w.lvisApi.tour.start = async (scenarioId) => {
      w.__lvisTutorialTourCalls.push({ scenarioId });
      try {
        await original(scenarioId);
      } catch {
        /* swallow — the broadcast side-effect isn't relevant here */
      }
      return { ok: true };
    };
  });

  // Trigger the dialog the same way the Help menu broadcast would.
  await mainWindow.evaluate(() => {
    const w = window as unknown as {
      lvisApi: { tutorialOpen: () => Promise<unknown> };
    };
    return w.lvisApi.tutorialOpen();
  });

  const dialog = mainWindow.getByTestId('tutorial-dialog');
  await expect(dialog).toBeVisible();
  await expect(mainWindow.getByTestId('tutorial-dialog:progress')).toHaveText('1 / 5');

  // Card 1 disliked.
  await mainWindow.getByTestId('tutorial-dialog:dislike').click();
  await expect(mainWindow.getByTestId('tutorial-dialog:progress')).toHaveText('2 / 5');

  // Card 2 (doc-search) liked — this should be the dispatched scenario.
  const card2 = mainWindow.getByTestId('tutorial-dialog:top-card');
  const card2Id = await card2.getAttribute('data-card-id');
  expect(card2Id).toBe('doc-search');
  await mainWindow.getByTestId('tutorial-dialog:like').click();
  await expect(mainWindow.getByTestId('tutorial-dialog:progress')).toHaveText('3 / 5');

  // Cards 3, 4, 5 skipped via spacebar.
  for (let i = 0; i < 3; i += 1) {
    await mainWindow.keyboard.press('Space');
  }

  await expect(mainWindow.getByTestId('tutorial-dialog:finished')).toBeVisible();

  // The dialog should have dispatched the first liked card's scenario id.
  const calls = await mainWindow.evaluate(() => {
    return (window as unknown as { __lvisTutorialTourCalls: { scenarioId: string }[] }).
      __lvisTutorialTourCalls;
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].scenarioId).toBe('doc-search-tour');

  // Close the summary and assert the dialog tears down cleanly.
  await mainWindow.getByTestId('tutorial-dialog:close').click();
  await expect(dialog).toHaveCount(0);
});
