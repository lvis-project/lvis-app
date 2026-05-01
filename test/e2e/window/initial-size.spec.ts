/**
 * initial-size E2E (PR #368 follow-up — narrow width, restored height).
 *
 * Verifies that on first launch (no persisted window-state.json) the main
 * BrowserWindow is created at the correct dimensions:
 *   width  ≤ 600 px  (target 560 — narrow chat column from #364)
 *   height ≤ 760 px  (target 720 — restored from original; PR #368 incorrectly halved this)
 *
 * Uses `app.evaluate` to read bounds directly via Electron BrowserWindow APIs.
 * Skipped automatically when the built app binary is absent so CI that doesn't
 * run Electron tests is unaffected.
 */
import { test, expect } from "@playwright/test";
import { _electron as electron, ElectronApplication } from "playwright";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = resolve(HERE, "../../../dist/src/main.cjs");
const WINDOW_STATE_PATH = resolve(homedir(), ".lvis", "window-state.json");

test.describe("initial window size", () => {
  test.skip(!existsSync(DIST_MAIN), "dist/src/main.cjs not built — skipping");

  let app: ElectronApplication;

  test.beforeEach(async () => {
    // Remove persisted window-state so we test the hard-coded defaults.
    if (existsSync(WINDOW_STATE_PATH)) {
      rmSync(WINDOW_STATE_PATH);
    }
    app = await electron.launch({ args: [DIST_MAIN] });
  });

  test.afterEach(async () => {
    await app.close();
  });

  test("main window opens at narrow-width, full-height dimensions (≤ 600×760)", async () => {
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      return win.getBounds();
    });

    expect(bounds.width).toBeLessThanOrEqual(600);
    expect(bounds.height).toBeLessThanOrEqual(760);
    // Ensure height is not accidentally compact (the PR #368 regression was 380px)
    expect(bounds.height).toBeGreaterThanOrEqual(600);
  });
});
