import { test, expect } from "./fixtures";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

test.describe("workspace rail redesign", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-workspace-rail-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-workspace-rail-home-"));
    writeFileSync(
      resolve(userDataDir, "lvis-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        LVIS_HOME: resolve(tempHome, ".lvis"),
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        LVIS_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("docked rail: no header count, drag splitter, launcher opens a tab", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();

    const panel = page.getByTestId("chat-side-panel");
    await expect(panel).toBeVisible();

    // Header shows the title only — the removed count read "미리보기 N개 · 파일 M개".
    const rail = page.getByTestId("chat-preview-rail");
    await expect(rail).not.toContainText("· 파일");

    // Docked variant exposes the left-edge width drag handle.
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();

    // Empty workspace shows the launcher; opening the browser item creates a tab.
    await expect(page.getByTestId("chat-side-panel-launcher")).toBeVisible();
    await page.getByTestId("chat-side-panel-launcher-browser").click();
    await expect(page.getByTestId("chat-side-panel-tab-browser")).toBeVisible();
  });

  test("narrow viewport falls back to the modal drawer", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();

    // Shrink below the docked threshold → the rail moves into the drawer sheet.
    await page.setViewportSize({ width: 460, height: 840 });
    const drawer = page.getByTestId("workspace-rail-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("chat-side-panel")).toBeVisible();
    // The drawer variant drops the drag handle (the sheet owns width).
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toHaveCount(0);

    // Widen again → back to docked.
    await page.setViewportSize({ width: 1400, height: 840 });
    await expect(page.getByTestId("workspace-rail-drawer")).toHaveCount(0);
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
  });
});
