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

/**
 * Side-chat tab render smoke — opens the dedicated side-chat workspace tab in a
 * real Electron boot and asserts the SideChatView (its own composer / New / send
 * affordances) renders. This exercises the second ConversationLoop's UI surface
 * end-to-end (boot wiring → dedicated IPC preload → SideChatView) without a live
 * LLM: it proves the engine is reachable, not the model round-trip (the seeded
 * `sk-e2e-*` key does not produce a real stream).
 */
test.describe("side-chat tab", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-side-chat-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-side-chat-home-"));
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

  test("opens the side-chat tab and renders the dedicated SideChatView", async () => {
    await page.getByTestId("chat-side-panel-toggle").click();
    await expect(page.getByTestId("chat-side-panel")).toBeVisible();

    // The launcher exposes side chat as a first-class workspace item.
    const launcher = page.getByTestId("chat-side-panel-launcher-side-chat");
    await expect(launcher).toBeVisible();
    await launcher.click();

    // The dedicated, lightweight SideChatView mounts (not a placeholder).
    await expect(page.getByTestId("side-chat-view")).toBeVisible();
    await expect(page.getByTestId("chat-side-panel-side-chat-placeholder")).toHaveCount(0);

    // Its own composer + New affordance are present, and the composer is
    // independent of the main chat's textarea.
    await expect(page.getByTestId("side-chat-composer")).toBeVisible();
    await expect(page.getByTestId("side-chat-new")).toBeVisible();
    // Idle: New is enabled (only disabled mid-stream — MAJOR 2 UI guard).
    await expect(page.getByTestId("side-chat-new")).toBeEnabled();
  });
});
