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
 * Workspace-rail follow-up (#1445 file-content preview + tab-bar scroll/drag +
 * project-path selection). Verifies the diagnosis-①/②/③ fixes in the packaged
 * renderer against a real, allow-listed project folder.
 */
test.describe("workspace rail follow-up", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;
  let workspaceDir: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-wsrail-followup-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-wsrail-followup-home-"));
    // The default project root is process.cwd() = LVIS_HOME/workspace; seed a
    // real markdown file there so the file-browser can list + open it.
    workspaceDir = resolve(tempHome, ".lvis", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      resolve(workspaceDir, "architecture.md"),
      "# Architecture Doc\n\nreal-file-content-marker\n",
      "utf-8",
    );
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

  test("file-browser: project root lists a file and opens its real content", async () => {
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();

    await page.getByTestId("chat-side-panel-launcher-file-browser").click();

    // The project-roots browser is present (diagnosis ③) with the seeded file.
    await expect(page.getByTestId("chat-side-panel-project-roots")).toBeVisible();
    const fileRow = page.getByTestId("chat-side-panel-fs-file").filter({ hasText: "architecture.md" });
    await expect(fileRow).toBeVisible({ timeout: 10_000 });

    // Opening it loads the real content via the preview IPC (diagnosis ①) —
    // not a path-only placeholder.
    await fileRow.click();
    await expect(page.getByTestId("chat-side-panel-file-preview")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-markdown")).toContainText("real-file-content-marker");
  });

  test("tab bar: many tabs stay reachable via horizontal scroll (diagnosis ②)", async () => {
    await page.setViewportSize({ width: 900, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();

    // Open enough tabs that the strip is guaranteed to overflow its width. The
    // FIRST tab comes from the empty-state launcher (no tabs → no tab bar yet);
    // the tab-bar "+" (add-tab) menu only appears once at least one tab exists.
    const kinds = ["file-browser", "browser", "terminal", "preview"] as const;
    await page.getByTestId(`chat-side-panel-launcher-${kinds[0]}`).click();
    for (const kind of [...kinds.slice(1), ...kinds]) {
      await page.getByTestId("chat-side-panel-add-tab").click();
      await page.getByTestId(`chat-side-panel-launcher-menu-${kind}`).click();
    }

    const scroll = page.getByTestId("chat-side-panel-tab-scroll");
    await expect(scroll).toBeVisible();

    // The strip is horizontally scrollable and scrollLeft can advance.
    const canScroll = await scroll.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(canScroll).toBe(true);
    await scroll.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const scrolled = await scroll.evaluate((el) => el.scrollLeft);
    expect(scrolled).toBeGreaterThan(0);
  });
});
