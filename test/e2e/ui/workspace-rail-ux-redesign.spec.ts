import { test, expect } from "./fixtures";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

/**
 * Workspace-rail UX redesign (vertical resize, browser de-nest + search Popover,
 * file-source segment, subagent viewer). Drives the packaged renderer against a
 * real, allow-listed project folder.
 */
test.describe("workspace rail UX redesign", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;
  let workspaceDir: string;

  async function launch() {
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
  }

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-wsrail-ux-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-wsrail-ux-home-"));
    workspaceDir = resolve(tempHome, ".lvis", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(resolve(workspaceDir, "architecture.md"), "# Architecture\n\nmarker\n", "utf-8");
    writeFileSync(
      resolve(userDataDir, "lvis-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    await launch();
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("file tab: directory/session segment toggle (default directory, session disabled empty)", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();
    await page.getByTestId("chat-side-panel-launcher-file-browser").click();

    // Directory is the default source; the project file is listed there.
    await expect(page.getByTestId("chat-side-panel-file-source-directory")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("chat-side-panel-fs-file").filter({ hasText: "architecture.md" })).toBeVisible();

    // No chat has run, so there are no session artifacts → the segment is disabled
    // with a 0 count.
    const sessionSeg = page.getByTestId("chat-side-panel-file-source-session");
    await expect(sessionSeg).toBeDisabled();
    await expect(page.getByTestId("chat-side-panel-file-source-session-count")).toHaveText("0");

    // R3: the segment strip is compact — its total footprint stays ~24-28px so
    // it does not crowd the narrow file pane. Each button is 24px (h-6).
    const dirBtnBox = await page.getByTestId("chat-side-panel-file-source-directory").boundingBox();
    expect(dirBtnBox).not.toBeNull();
    expect(dirBtnBox!.height).toBeLessThanOrEqual(26);
    const stripBox = await page.getByTestId("chat-side-panel-file-source-segment").boundingBox();
    expect(stripBox).not.toBeNull();
    expect(stripBox!.height).toBeLessThanOrEqual(30);

    // R3: no dead search — the search box is not rendered on the Directory
    // segment (ProjectRootsBrowser has no query wiring).
    await expect(page.getByTestId("chat-preview-search")).toHaveCount(0);

    const shot = await page.getByTestId("chat-side-panel").screenshot();
    await test.info().attach("file-source-segment.png", { contentType: "image/png", body: shot });
  });

  test("file tab: the vertical separator has a ≥20px drag hit zone (R1)", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await page.getByTestId("chat-side-panel-launcher-file-browser").click();

    const splitter = page.getByTestId("chat-side-panel-file-splitter");
    await expect(splitter).toBeVisible();
    // The separator ROW is 1.25rem (20px) tall — the whole row is the pointer
    // target — so a drag is reliable even though the visible line is 2px.
    const box = await splitter.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(20);

    const shot = await page.getByTestId("chat-side-panel").screenshot();
    await test.info().attach("separator-drag-zone.png", { contentType: "image/png", body: shot });
  });

  test("file tab: vertical splitter persists across restart", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await page.getByTestId("chat-side-panel-launcher-file-browser").click();

    const splitLayout = page.getByTestId("chat-side-panel-file-split-layout");
    await expect(splitLayout).toBeVisible();
    const before = await splitLayout.evaluate((el) => (el as HTMLElement).style.gridTemplateRows);

    // Keyboard-drive the splitter (deterministic vs a pixel drag) and confirm it
    // moved, then persisted the new ratio.
    const splitter = page.getByTestId("chat-side-panel-file-splitter");
    await splitter.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    await expect
      .poll(async () => splitLayout.evaluate((el) => (el as HTMLElement).style.gridTemplateRows))
      .not.toBe(before);
    const afterDrag = await splitLayout.evaluate((el) => (el as HTMLElement).style.gridTemplateRows);

    // Restart the app against the same user-data dir; the split ratio survives.
    await app.close();
    await launch();
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await page.getByTestId("chat-side-panel-launcher-file-browser").click();
    await expect
      .poll(async () =>
        page.getByTestId("chat-side-panel-file-split-layout").evaluate((el) => (el as HTMLElement).style.gridTemplateRows),
      )
      .toBe(afterDrag);
  });

  test("browser tab: single address bar + floating search Popover (no duplicate bar)", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await page.getByTestId("chat-side-panel-launcher-browser").click();

    const panel = page.getByTestId("chat-side-panel");
    // Exactly ONE address bar (the duplicated viewer header is suppressed).
    await expect(panel.getByTestId("chat-side-panel-browser-address")).toHaveCount(1);
    // The always-on search strip is gone; the search lives behind the 🔍 button.
    await expect(page.getByTestId("chat-side-panel-browser-search-trigger")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-browser-search-popover")).toHaveCount(0);
    await page.getByTestId("chat-side-panel-browser-search-trigger").click();
    await expect(page.getByTestId("chat-side-panel-browser-search-popover")).toBeVisible();

    const shot = await panel.screenshot();
    await test.info().attach("browser-single-address-search-popover.png", { contentType: "image/png", body: shot });
  });

  test("subagent tab: opens from the launcher and shows the empty state", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await expect(page.getByTestId("chat-side-panel-launcher-subagent")).toBeVisible();
    // side-chat is reserved but never a launcher item (no dead affordance).
    await expect(page.getByTestId("chat-side-panel-launcher-side-chat")).toHaveCount(0);

    await page.getByTestId("chat-side-panel-launcher-subagent").click();
    await expect(page.getByTestId("chat-side-panel-tab-subagent")).toBeVisible();
    // No spawns in a fresh session → empty state.
    await expect(page.getByTestId("chat-side-panel-subagent-empty")).toBeVisible();

    const shot = await page.getByTestId("chat-side-panel").screenshot();
    await test.info().attach("subagent-tab-empty.png", { contentType: "image/png", body: shot });
  });
});
