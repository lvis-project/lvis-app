/**
 * initial-size E2E (PR #368 follow-up — narrow width, right-docked tall height).
 *
 * Verifies that on first launch (no persisted window-state.json) the main
 * BrowserWindow is created at the correct dimensions:
 *   width  ≤ 600 px  (target 560 — narrow chat column from #364)
 *   height ≈ 936 px  (720px + 30% vertical room)
 *   right edge aligns with the primary work area so the detached shell can
 *   magnetically attach to the main window's left edge.
 *
 * Uses `app.evaluate` to read bounds directly via Electron BrowserWindow APIs.
 * Skipped automatically when the built app binary is absent so CI that doesn't
 * run Electron tests is unaffected.
 */
import { test, expect } from "@playwright/test";
import { _electron as electron, ElectronApplication } from "playwright";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_MAIN = resolve(HERE, "../../../dist/src/main.js");

test.describe("initial window size", () => {
  test.skip(!existsSync(DIST_MAIN), "dist/src/main.js not built — skipping");

  let app: ElectronApplication;
  let tempHome: string;
  let userDataDir: string;

  test.beforeEach(async () => {
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-e2e-home-"));
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-e2e-initial-size-"));
    app = await electron.launch({
      args: [DIST_MAIN, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: {
        ...process.env,
        HOME: tempHome,
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
      timeout: 30_000,
    });
    await app.firstWindow();
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("main window opens narrow, taller, and right-aligned", async () => {
    const { bounds, workArea } = await app.evaluate(({ BrowserWindow, screen }) => {
      const [win] = BrowserWindow.getAllWindows();
      if (!win) throw new Error("main BrowserWindow was not created");
      return {
        bounds: win.getBounds(),
        workArea: screen.getPrimaryDisplay().workArea,
      };
    });

    expect(bounds.width).toBe(Math.min(560, workArea.width));
    expect(bounds.height).toBe(Math.min(936, workArea.height));
    expect(bounds.x + bounds.width).toBe(workArea.x + workArea.width);
    expect(bounds.y).toBe(workArea.y + Math.min(24, Math.max(0, workArea.height - bounds.height)));
    // Ensure height is not accidentally compact (the PR #368 regression was 380px)
    expect(bounds.height).toBeGreaterThanOrEqual(600);
  });
});
