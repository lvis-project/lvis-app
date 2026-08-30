import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';
import { TEST_IDS } from "../../../src/shared/test-ids.js";

/**
 * Settings → Model: the model dropdown's layout.
 *
 * A real provider catalog is long in both directions — dozens of ids, each too
 * wide for the trigger, each carrying a provider/context/pricing detail line.
 * Radix `Select` content defaults to `position="item-aligned"`, which anchors
 * the selected row on top of the trigger and sizes the popup to its own widest
 * row. With the selection near the top of a long list that leaves the list only
 * the room below the trigger — an 80-model catalog rendered into a 230px popup
 * (4.4 rows of 80) whose box no longer matches the control it belongs to.
 *
 * The list is seeded through the persisted `llm.modelListCache`, so no /models
 * handshake and no network is involved: `LlmTab`'s settings effect hydrates the
 * cache and renders exactly these ids.
 */

const OWNERS = Array.from({ length: 8 }, (_, i) => `upstream-owner-${i}`);
const SUFFIXES = [
  'instruct-preview:free',
  'instruct-2025-01-20:free',
  'instruct-fp8-turbo-preview',
  'long-context-preview',
  'quantized-awq-preview',
];
/** Catalog-sized: long ids, more rows than any popup can show at once. */
const MODEL_IDS = Array.from(
  { length: 80 },
  (_, i) => `${OWNERS[i % OWNERS.length]}/model-family-${i}-${SUFFIXES[i % SUFFIXES.length]}`,
);

function seededModelListCache() {
  return {
    'openai-compatible\n\n': {
      vendor: 'openai-compatible',
      endpoint: 'https://models.e2e.invalid/v1/models',
      models: MODEL_IDS,
      modelEntries: MODEL_IDS.map((id, index) => ({
        id,
        provider: 'some-upstream-provider-name',
        contextLength: 1_048_576,
        pricing: { prompt: '0.00000012', completion: '0.00000042' },
        tags: index % 5 === 0 ? { free: true } : {},
      })),
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

/**
 * A squeezed popup is the symptom, so the floor has to be well above the 230px
 * the broken layout produced and at or under the 386px cap the fix applies.
 */
const MIN_POPUP_HEIGHT = 320;

/** Resize the app window itself; the settings shell keys off the panel width. */
async function setWindowSize(
  app: import('@playwright/test').ElectronApplication,
  w: number,
  h: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed() && x.isVisible());
    const target = wins.sort(
      (a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1],
    )[0];
    if (target) target.setContentSize(size.w, size.h);
  }, { w, h });
}

for (const bundleId of ['violet-light', 'violet-dark'] as const) {
  for (const { name: sizeName, width } of [
    { name: 'wide', width: 1200 },
    { name: 'narrow', width: 620 },
  ]) {
    test(`model dropdown is trigger-aligned and uses the available height (${bundleId}, ${sizeName})`, async ({
      app,
      mainWindow,
    }) => {
      await mainWindow.evaluate(
        async ({ cache, bundle }) => {
          const api = (window as unknown as {
            lvisApi: { updateSettings: (patch: unknown) => Promise<unknown> };
          }).lvisApi;
          await api.updateSettings({
            appearance: { schemaVersion: 2, bundleId: bundle },
            llm: { provider: 'openai-compatible', modelListCache: cache },
          });
        },
        { cache: seededModelListCache(), bundle: bundleId },
      );

      const settingsPage = await openInlineSettings(app, mainWindow, 'llm');
      await setWindowSize(app, width, 860);
      const shell = settingsPage.locator('[data-settings-layout]');
      await expect
        .poll(async () => shell.getAttribute('data-settings-layout'), { timeout: 5_000 })
        .toBe(sizeName === 'wide' ? 'wide' : 'narrow');
      if (sizeName === 'narrow') {
        // The narrow shell is a 2-depth stack; drill into the Model category so
        // the model dropdown is on screen.
        await settingsPage.getByRole('tab', { name: /Model|모델/ }).first().click();
        await expect(settingsPage.getByTestId(TEST_IDS.settingsMobileBack)).toBeVisible();
      }

      const modelSelect = settingsPage.getByTestId(TEST_IDS.llmModelSelect);
      await expect(modelSelect).toBeVisible({ timeout: 10_000 });
      // The seeded ids only reach the dropdown once the cache-hydration effect
      // has run; the sync status line reports the hydrated catalog size.
      await expect(settingsPage.getByTestId('llm-tab:model-sync-status')).toBeVisible({
        timeout: 10_000,
      });
      await modelSelect.click();

      const content = settingsPage.locator('[data-slot="select-content"]');
      await expect(content).toBeVisible({ timeout: 10_000 });
      await expect(content.locator('[data-slot="select-item"]').first()).toBeVisible();

      const metrics = await settingsPage.evaluate(() => {
        const node = document.querySelector('[data-slot="select-content"]') as HTMLElement | null;
        const trigger = document.querySelector('#model-select') as HTMLElement | null;
        const rect = (el: HTMLElement | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width, height: r.height };
        };
        const items = [...(node?.querySelectorAll('[data-slot="select-item"]') ?? [])].map((el) => {
          const item = el as HTMLElement;
          const r = item.getBoundingClientRect();
          // The id itself lives in the row's own truncating box.
          const label = item.querySelector('span.truncate') as HTMLElement | null;
          const labelRect = label?.getBoundingClientRect();
          return {
            text: (item.textContent ?? '').slice(0, 60),
            right: r.right,
            scrollWidth: item.scrollWidth,
            clientWidth: item.clientWidth,
            labelRight: labelRect?.right ?? 0,
            labelEllipsized: label ? getComputedStyle(label).textOverflow === 'ellipsis' : false,
          };
        });
        return {
          innerWidth: window.innerWidth,
          docScrollWidth: document.documentElement.scrollWidth,
          content: rect(node),
          trigger: rect(trigger),
          itemCount: items.length,
          items,
        };
      });

      expect(metrics.content).not.toBeNull();
      expect(metrics.trigger).not.toBeNull();
      const popup = metrics.content!;
      const trigger = metrics.trigger!;
      expect(metrics.itemCount).toBe(MODEL_IDS.length);

      // The popup belongs to its trigger: same left edge, same width.
      expect(Math.abs(popup.left - trigger.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(popup.width - trigger.width)).toBeLessThanOrEqual(1);

      // ...and it must stay inside the window rather than push the page sideways.
      expect(popup.right).toBeLessThanOrEqual(metrics.innerWidth + 1);
      expect(popup.left).toBeGreaterThanOrEqual(-1);
      expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);

      // A catalog-sized list gets the room that is actually available.
      expect(popup.height).toBeGreaterThanOrEqual(MIN_POPUP_HEIGHT);

      for (const item of metrics.items) {
        expect(item.right).toBeLessThanOrEqual(popup.right + 1);
        // `select-content` is `overflow-x-hidden`: a row wider than its box is
        // clipped with no way to scroll to the rest of it.
        expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1);
        // The id gets an ellipsis inside the row rather than pushing past it.
        expect(item.labelEllipsized).toBe(true);
        expect(item.labelRight).toBeLessThanOrEqual(item.right + 1);
      }

      await settingsPage.keyboard.press('Escape');
      await expect(content).toHaveCount(0);
      if (sizeName === 'wide') await closeInlineSettings(app, settingsPage);
    });
  }
}
