import { test, expect } from "./fixtures";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron";
import type { AgentSpawnEvent } from "../../../src/shared/subagent-events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");
const CLEANUP_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

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
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
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
      try {
        page = await app.firstWindow();
        await page.locator('[data-testid="main-toolbar"]').first().waitFor({ state: "visible", timeout: 60_000 });
        return;
      } catch (err) {
        lastError = err;
        await app?.close().catch(() => {});
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Electron launch failed");
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
    if (userDataDir) rmSync(userDataDir, CLEANUP_RM_OPTIONS);
    if (tempHome) rmSync(tempHome, CLEANUP_RM_OPTIONS);
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
    // side-chat is a first-class launcher item alongside sub-agent — both are
    // live surfaces, both openable from the same empty-state picker.
    await expect(page.getByTestId("chat-side-panel-launcher-side-chat")).toBeVisible();

    await page.getByTestId("chat-side-panel-launcher-subagent").click();
    await expect(page.getByTestId("chat-side-panel-tab-subagent")).toBeVisible();
    // No spawns in a fresh session → empty state.
    await expect(page.getByTestId("chat-side-panel-subagent-empty")).toBeVisible();

    const shot = await page.getByTestId("chat-side-panel").screenshot();
    await test.info().attach("subagent-tab-empty.png", { contentType: "image/png", body: shot });
  });

  test("subagent tab: a spawn + its resume (shared childSessionId) render as ONE unified, live-growing transcript", async () => {
    // Inject the real `lvis:agent-spawn:event` stream (the same channel the main
    // process forwards on) so the renderer's live spawn hook + the viewer's
    // groupSubAgentSessions run end-to-end without a real LLM. The original spawn
    // and its resume are two separate agent_spawn calls (two spawnIds/toolUseIds)
    // that share ONE childSessionId — the viewer must unify them into a single
    // row whose transcript concatenates both segments.
    await page.setViewportSize({ width: 1400, height: 840 });
    await page.getByTestId("chat-side-panel-toggle").click();
    await page.getByTestId("chat-side-panel-launcher-subagent").click();
    await expect(page.getByTestId("chat-side-panel-tab-subagent")).toBeVisible();

    const sendSpawn = async (event: AgentSpawnEvent): Promise<void> => {
      await app.evaluate(({ BrowserWindow }, ev) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (!win) return;
        win.webContents.send("lvis:agent-spawn:event", ev);
      }, event);
    };

    const CHILD = "e2e-child-session";
    // 1) original spawn runs to an INCOMPLETE finish (learns its childSessionId
    //    on `done`, the first phase to carry the join key).
    await sendSpawn({ spawnId: "e2e-orig", type: "start", taskState: "TASK_STATE_SUBMITTED", title: "E2E research", instructions: "E2E prompt", toolUseId: "tu-orig" });
    await sendSpawn({
      spawnId: "e2e-orig",
      type: "done",
      taskState: "TASK_STATE_INPUT_REQUIRED",
      status: "waiting",
      summary: "partial",
      toolCallCount: 2,
      childSessionId: CHILD,
      suspension: { reason: "budget", resumeId: CHILD },
      entries: [{ kind: "assistant", text: "ORIGINAL_SEGMENT", streaming: false }],
    });

    const detail = page.getByTestId("chat-side-panel-subagent-detail");
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toHaveCount(1);
    await expect(detail.getByTestId("chat-side-panel-subagent-transcript")).toBeVisible();
    await expect(detail).toContainText("E2E prompt");
    await expect(detail).toContainText("ORIGINAL_SEGMENT");

    // 2) a resume (separate spawnId, SAME childSessionId) starts and streams a
    //    growing tail. The unified transcript's prefix (the original segment)
    //    must stay stable while the tail grows — no flicker / re-mount.
    await sendSpawn({ spawnId: "e2e-resume", type: "start", taskState: "TASK_STATE_INPUT_REQUIRED", title: "(sub-agent)", instructions: "resume prompt", toolUseId: "tu-resume", childSessionId: CHILD });
    await sendSpawn({
      spawnId: "e2e-resume",
      type: "activity",
      taskState: "TASK_STATE_WORKING",
      toolCallCount: 1,
      childSessionId: CHILD,
      entries: [{ kind: "assistant", text: "RESUME_TAIL_A", streaming: false }],
    });

    // Still ONE row; prefix stable, first tail chunk appended.
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toHaveCount(1);
    await expect(detail).toContainText("ORIGINAL_SEGMENT");
    await expect(detail).toContainText("RESUME_TAIL_A");

    await sendSpawn({
      spawnId: "e2e-resume",
      type: "done",
      taskState: "TASK_STATE_COMPLETED",
      status: "done",
      summary: "done",
      toolCallCount: 2,
      childSessionId: CHILD,
      entries: [
        { kind: "assistant", text: "RESUME_TAIL_A", streaming: false },
        { kind: "assistant", text: "RESUME_TAIL_B", streaming: false },
      ],
    });

    // Final assertion: ONE row, and the concatenated transcript is ordered
    // original → resume tail A → resume tail B (stable prefix, grown tail).
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toHaveCount(1);
    await expect(detail).toContainText("RESUME_TAIL_B");
    const order = await detail.evaluate((el) => {
      const text = el.textContent ?? "";
      return {
        prompt: text.indexOf("E2E prompt"),
        orig: text.indexOf("ORIGINAL_SEGMENT"),
        tailA: text.indexOf("RESUME_TAIL_A"),
        tailB: text.indexOf("RESUME_TAIL_B"),
      };
    });
    expect(order.prompt).toBeGreaterThanOrEqual(0);
    expect(order.orig).toBeGreaterThan(order.prompt);
    expect(order.tailA).toBeGreaterThan(order.orig);
    expect(order.tailB).toBeGreaterThan(order.tailA);
    // The row carries the ORIGINAL's title (one logical agent = one name).
    await expect(page.getByTestId("chat-side-panel-subagent-row")).toContainText("E2E research");

    const shot = await page.getByTestId("chat-side-panel").screenshot();
    await test.info().attach("subagent-tab-unified-resume.png", { contentType: "image/png", body: shot });
  });
});
