import { test, expect } from './fixtures.js';
import { openInlineSettings, closeInlineSettings } from './inline-settings.js';

/**
 * Price corrections — real-Electron round trip.
 *
 * The unit tests cover the table, the parse and the merge. What they cannot
 * cover is whether a rate typed into the table reaches the settings service
 * the usage aggregation reads: `registerUsageHandlers` pulls
 * `llm.pricingOverrides` per call precisely so a correction saved now changes
 * the next Usage query rather than the next launch, and a control that only
 * moved renderer state would look correct in every unit test while every
 * reported cost stayed at list price.
 */
test('a price correction round-trips through the real settings service', async ({ app, mainWindow }) => {
  const settingsPage = await openInlineSettings(app, mainWindow, 'llm');

  const readOverrides = () =>
    settingsPage.evaluate(async () => {
      const api = (window as unknown as {
        lvisApi: { getSettings: () => Promise<unknown> };
      }).lvisApi;
      const settings = (await api.getSettings()) as {
        llm?: { pricingOverrides?: unknown[] };
      };
      return settings.llm?.pricingOverrides ?? [];
    });

  // Nothing pins the variable in this harness, so the table must be editable.
  await expect(settingsPage.getByTestId('llm-pricing-overrides-forced')).toHaveCount(0);
  await expect(settingsPage.getByTestId('llm-pricing-overrides-empty')).toBeVisible();

  const save = settingsPage.getByTestId('llm-pricing-override-save');
  await settingsPage.getByTestId('llm-pricing-override-add').click();
  // An incomplete row is not savable — the store would drop it silently.
  await expect(save).toBeDisabled();
  await expect(settingsPage.getByTestId('llm-pricing-override-incomplete')).toBeVisible();

  await settingsPage.getByTestId('llm-pricing-override-vendor-0').selectOption('claude');
  await settingsPage.getByTestId('llm-pricing-override-model-0').fill('claude-sonnet-4-6');
  await settingsPage.getByTestId('llm-pricing-override-input-0').fill('2.5');
  await settingsPage.getByTestId('llm-pricing-override-output-0').fill('11');
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(readOverrides).toEqual([
    { vendor: 'claude', model: 'claude-sonnet-4-6', inputPer1M: 2.5, outputPer1M: 11 },
  ]);

  // And back out again: a correction has to be removable, or a wrong rate is
  // as permanent as the list price it replaced.
  await settingsPage.getByTestId('llm-pricing-override-remove-0').click();
  await save.click();
  await expect.poll(readOverrides).toEqual([]);

  await closeInlineSettings(app, settingsPage);
});
