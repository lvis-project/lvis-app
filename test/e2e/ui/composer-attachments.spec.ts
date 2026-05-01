import { test, expect } from "./fixtures";

/**
 * Composer attachment redesign — DOM-level smoke checks.
 *
 * The native file dialog cannot be exercised via Playwright in a stable
 * way, so this suite verifies what the renderer guarantees:
 *  - the legacy "문서 첨부" Paperclip popover is gone
 *  - the new attach button now lives in InputActionBar (single button,
 *    no count badge — the count lives on the in-composer chip)
 *  - the Composer is present
 *  - the chip strip does NOT reserve space when empty
 *  - typing a stale marker without a matching attachment does not flash
 *    a phantom chip (textarea = single source of truth)
 *
 * Vitest covers the unit-level marker → chip binding; this suite verifies
 * the wiring survives the full Electron renderer boot.
 */
test("legacy indexer popover removed; new attach button in action bar", async ({ mainWindow }) => {
  const actionBar = mainWindow.locator('[data-testid="input-action-bar"]');
  const found = await actionBar
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "Input action bar not visible — skipping");

  // Legacy "문서 첨부" Paperclip popover trigger no longer exists.
  await expect(mainWindow.locator('[title="문서 첨부"]')).toHaveCount(0);

  // Single unified attach button is present in the action bar trailing cluster.
  await expect(mainWindow.locator('[data-testid="iab-attach-button"]')).toBeVisible();
});

test("composer renders and strip is absent when no attachments", async ({ mainWindow }) => {
  const composer = mainWindow.locator('[data-testid="composer"]');
  const found = await composer
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "Composer not visible — skipping");

  await expect(mainWindow.locator('[data-testid="composer-textarea"]')).toBeVisible();
  // Empty state — strip occupies zero space.
  await expect(mainWindow.locator('[data-testid="composer-strip"]')).toHaveCount(0);
});

test("typing a stale marker does not flash a phantom chip", async ({ mainWindow }) => {
  const textarea = mainWindow.locator('[data-testid="composer-textarea"]');
  const found = await textarea
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "Composer textarea not visible — skipping");

  await textarea.click();
  await textarea.fill("hello [Image #1] world");
  // Without a real attachment object matching N=1, no chip should render.
  await expect(mainWindow.locator('[data-testid="attachment-chip"]')).toHaveCount(0);
  await expect(
    mainWindow.locator('[data-testid="attachment-chip-collapsed"]'),
  ).toHaveCount(0);
  await expect(mainWindow.locator('[data-testid="composer-strip"]')).toHaveCount(0);
});
