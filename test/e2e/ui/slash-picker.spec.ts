import { test, expect } from './fixtures';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

/**
 * E2E for the composer's command button.
 *
 * The menu itself is the OS's, so there is no popover to locate, no row to
 * click, and nothing a screenshot can show. What is still end-to-end — and what
 * these tests hold — is everything up to the OS: the button is on screen, both
 * ways of raising the menu reach the preload bridge, and the payload the
 * renderer builds from the REAL app (its installed plugins, its connected MCP
 * servers, its registered skills) has the shape the menu is drawn from.
 *
 * Typing to filter is a different surface and still fully drivable: "/" in the
 * composer opens `InlineSlashMenu`, covered by its own specs.
 *
 * Requires `bun run build`. A missing trigger is a real regression, never a skip.
 */

type MenuRow = { id: string; label: string; submenu?: MenuRow[] };
type MenuPayload = { requestId: string; x: number; y: number; sections: Array<{ items: MenuRow[] }> };

/** Hold what the renderer hands the bridge, and keep the menu off the screen. */
async function captureMenuPayloads(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const ui = (window as unknown as { lvis: { ui: Record<string, unknown> } }).lvis.ui;
    const captured: unknown[] = [];
    (window as unknown as { __menuPayloads: unknown[] }).__menuPayloads = captured;
    ui.showDynamicMenu = async (payload: unknown) => {
      captured.push(payload);
      return { ok: true };
    };
  });
}

const payloads = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __menuPayloads: MenuPayload[] }).__menuPayloads);

test('command button: both the click and Cmd/Ctrl+K raise the menu', async ({ mainWindow }) => {
  const trigger = mainWindow.locator(testIdSelector(TEST_IDS.slashPickerTrigger));
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await captureMenuPayloads(mainWindow);

  await trigger.click();
  await expect.poll(() => payloads(mainWindow).then((p) => p.length)).toBe(1);

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await mainWindow.keyboard.press(`${mod}+k`);
  await expect.poll(() => payloads(mainWindow).then((p) => p.length)).toBe(2);

  // The menu drops from the button, so it is anchored to it rather than to the
  // pointer — the shortcut has no pointer to anchor to.
  const box = await trigger.boundingBox();
  const [first] = await payloads(mainWindow) as MenuPayload[];
  expect(Math.abs(first!.x - Math.round(box!.x))).toBeLessThanOrEqual(2);
  expect(Math.abs(first!.y - Math.round(box!.y + box!.height))).toBeLessThanOrEqual(2);
});

test('command button: shortcuts stay flat and the installed lists sit behind submenus', async ({ mainWindow }) => {
  const trigger = mainWindow.locator(testIdSelector(TEST_IDS.slashPickerTrigger));
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await captureMenuPayloads(mainWindow);
  await trigger.click();
  await expect.poll(() => payloads(mainWindow).then((p) => p.length)).toBe(1);

  const [payload] = await payloads(mainWindow) as MenuPayload[];
  const [shortcuts, categories] = payload!.sections;

  // A native menu cannot filter as you type, so this shape IS the navigation:
  // what the user reaches for constantly is one click away, and what depends on
  // what is installed is one level down.
  expect(shortcuts!.items.length).toBeGreaterThan(0);
  expect(shortcuts!.items.every((row) => row.submenu === undefined)).toBe(true);
  expect(categories!.items.every((row) => (row.submenu?.length ?? 0) > 0)).toBe(true);

  const commands = categories!.items.find((row) => row.id === 'category:command');
  expect(commands).toBeDefined();
  expect(commands!.submenu!.some((row) => row.id === 'command:/new')).toBe(true);

  // Every leaf carries an id the renderer can resolve, and every label is one
  // line — main drops a row that is neither.
  const leaves = categories!.items.flatMap((row) => row.submenu ?? []);
  expect(leaves.every((row) => row.id.length > 0 && row.label.trim().length > 0)).toBe(true);
  expect(leaves.every((row) => !row.label.includes('\n'))).toBe(true);
});
