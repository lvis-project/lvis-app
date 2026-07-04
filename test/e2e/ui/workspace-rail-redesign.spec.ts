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

  test("chat mode at its side-panel window width docks (no modal blur)", async () => {
    // Regression guard for the chat-mode modal-blur bug: chat mode collapses the
    // sidebar to the icon rail and its OS window reserves the base width + the
    // 448px side panel (≈908px) when the panel opens. After the collapsed-sidebar
    // padding the chat-view-root sits just under the OLD 900px docking threshold,
    // so the panel wrongly rendered as a backdrop-blur modal drawer that blocked
    // the main chat. The threshold is now derived from the panel width + a
    // transcript floor, so this width docks — the transcript and the panel stay
    // interactive side by side, matching work mode.
    // Switch to chat mode (collapses the sidebar rail — the geometry the bug
    // manifests in) and open the panel first; the mode/panel IPC resizes the OS
    // window, so pin the container width LAST so it is the final authority.
    await page.getByTestId("app-mode-chat").click();
    await page.getByTestId("chat-side-panel-toggle").click();
    await page.setViewportSize({ width: 908, height: 840 });

    // Docked, not a modal drawer: no drawer sheet, no backdrop blur.
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();
    await expect(page.getByTestId("workspace-rail-drawer")).toHaveCount(0);
    await expect(page.getByTestId("workspace-rail-drawer-backdrop")).toHaveCount(0);
    // Docked variant exposes the drag handle (the modal drawer drops it).
    await expect(page.getByTestId("chat-side-panel-width-splitter")).toBeVisible();
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
