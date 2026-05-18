import { test, expect } from "./fixtures";

/**
 * Regression: the assistant-context button used to be pushed beyond the
 * right edge of the input action bar when the permission chip grew wide.
 *
 * The assistant context picker is now an Electron native menu, so submenu DOM
 * geometry is intentionally not observable from the renderer. This spec keeps
 * the user-visible invariant: fixed controls remain inside the action bar and
 * the variable permission slot is the part that yields under narrow widths.
 */

const ROLE_BUTTON = '[data-testid="iab-assistant-context-button"]';
const ACTION_BAR = '[data-testid="input-action-bar"]';
const TRAILING = '[data-testid="iab-trailing"]';
const PERMISSION_SLOTS = '[data-testid="iab-permission-slots"]';

async function resizeWindow(
  app: { evaluate: (fn: (electron: typeof import("electron"), arg: { w: number; h: number }) => unknown, arg: { w: number; h: number }) => Promise<unknown> },
  width: number,
  height: number,
) {
  await app.evaluate(({ BrowserWindow }, { w, h }) => {
    const wins = BrowserWindow.getAllWindows();
    const main = wins.find((win) => !win.isDestroyed() && win.isVisible()) ?? wins[0];
    if (!main) return;
    main.setBounds({ x: 0, y: 0, width: w, height: h });
  }, { w: width, h: height });
}

test("assistant context button stays inside the action bar at narrow width", async ({ app, mainWindow }) => {
  await resizeWindow(app as never, 460, 520);
  await mainWindow.waitForTimeout(250);
  await mainWindow.evaluate(() => {
    window.dispatchEvent(new CustomEvent("lvis:permissions:mode-changed", {
      detail: { mode: "auto" },
    }));
  });

  await mainWindow.locator(ROLE_BUTTON).waitFor({ state: "visible", timeout: 30_000 });

  const geometry = await mainWindow.evaluate(({ roleButton, actionBar, trailing, permissionSlots }) => {
    const btn = document.querySelector(roleButton) as HTMLElement | null;
    const bar = document.querySelector(actionBar) as HTMLElement | null;
    const trail = document.querySelector(trailing) as HTMLElement | null;
    const slots = document.querySelector(permissionSlots) as HTMLElement | null;
    if (!btn || !bar || !trail || !slots) {
      return { ok: false as const };
    }
    const btnRect = btn.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const trailRect = trail.getBoundingClientRect();
    const slotRect = slots.getBoundingClientRect();
    const trailStyle = getComputedStyle(trail);
    const slotStyle = getComputedStyle(slots);
    return {
      ok: true as const,
      vw: window.innerWidth,
      buttonLeft: btnRect.left,
      buttonRight: btnRect.right,
      buttonWidth: btnRect.width,
      barLeft: barRect.left,
      barRight: barRect.right,
      trailingRight: trailRect.right,
      slotWidth: slotRect.width,
      trailingOverflowX: trailStyle.overflowX,
      slotOverflowX: slotStyle.overflowX,
    };
  }, {
    roleButton: ROLE_BUTTON,
    actionBar: ACTION_BAR,
    trailing: TRAILING,
    permissionSlots: PERMISSION_SLOTS,
  });

  expect(geometry.ok).toBe(true);
  if (!geometry.ok) return;

  expect(geometry.buttonWidth).toBeGreaterThan(20);
  expect(geometry.buttonLeft).toBeGreaterThanOrEqual(geometry.barLeft);
  expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.barRight);
  expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.vw);
  expect(geometry.trailingRight).toBeLessThanOrEqual(geometry.barRight);
  expect(geometry.slotWidth).toBeGreaterThanOrEqual(0);
  expect(geometry.trailingOverflowX).toBe("hidden");
  expect(geometry.slotOverflowX).toBe("hidden");
});
