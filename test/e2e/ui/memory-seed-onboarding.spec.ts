/**
 * Tutorial-B (O-X2) — Memory Seed Onboarding Wizard e2e.
 *
 * Verifies the first-boot funnel:
 *   1. Fresh HOME (no `features.onboardingCompleted` set, no API keys)
 *      causes the wizard to auto-mount.
 *   2. Filling in 호칭 + 자기소개 → "기억하고 시작하기" dismisses the
 *      wizard and seeds `~/.lvis/memories/MEMORY.md` Urgent Memory.
 *   3. After dismissal the SpotlightTour spotlight visibly mounts. The
 *      production trigger is the Z chain-effect (App.tsx:699-711) firing
 *      `api.tour.start("first-boot-essentials")` on stage="tour" — the
 *      MemorySeed wizard's own `startTour()` is intentionally swallowed
 *      by an App.tsx-side `tour.start` wrapper to prevent a double-fire
 *      that would visibly reset the SpotlightTour to step 0 (regression
 *      from PR #1019; fix in #1029). This spec validates the *chain-effect
 *      driven* trigger path — the wizard's own startTour() lives only as
 *      a defensive secondary call for the dev-mode swallow-failure case.
 *   4. Subsequent boots do NOT re-show the wizard
 *      (`features.onboardingCompleted` flipped).
 */
import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

test.describe("memory seed onboarding wizard", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-memory-seed-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-memory-seed-home-"));

    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("auto-opens on first boot, seeds MEMORY.md, and the chain-effect tour broadcast mounts the SpotlightTour", async () => {
    await page.setViewportSize({ width: 460, height: 840 });

    const dialog = page.getByTestId("memory-seed-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    await dialog.getByTestId("memory-seed-dialog:name").fill("Ken");
    await dialog
      .getByTestId("memory-seed-dialog:intro")
      .fill("매주 회의가 많은 PM. 회의록 정리와 일정 관리 자동화에 관심.");

    // Live chip recomputation: meeting + ms-graph keywords are present.
    await expect(dialog.getByTestId("memory-seed-dialog:chip:meeting")).toBeVisible();
    await expect(dialog.getByTestId("memory-seed-dialog:chip:ms-graph")).toBeVisible();

    await dialog.getByTestId("memory-seed-dialog:submit").click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // SpotlightTour root mounts only after a `lvis:tour:start` broadcast.
    // Trigger origin is the chain-effect at App.tsx (stage="tour" branch),
    // NOT the wizard's internal startTour() — that path is intentionally
    // swallowed by the App.tsx-side `tour.start` wrapper to prevent the
    // double-mount regression (PR #1029). The chain-effect is the canonical
    // production trigger: this assertion proves the wizard's onDismissed →
    // dispatchChain("memory-finish") → stage="tour" → broadcast pipeline.
    await page
      .getByTestId("spotlight-tour")
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });

    // MEMORY.md should now carry both 호칭 + 자기소개 lines in Urgent Memory.
    const memoryPath = resolve(tempHome, ".lvis", "memories", "MEMORY.md");
    await expect.poll(() => existsSync(memoryPath), { timeout: 5_000 }).toBe(true);
    const md = readFileSync(memoryPath, "utf-8");
    expect(md).toContain("호칭: Ken");
    expect(md).toContain("자기소개: 매주 회의가 많은 PM");
  });

  test("does not re-open on the second boot once onboarding is completed", async () => {
    // First boot: dismiss via skip.
    const dialog = page.getByTestId("memory-seed-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByTestId("memory-seed-dialog:skip").click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // Close and re-launch with the same HOME — the wizard must NOT reopen.
    await app.close().catch(() => {});
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: {
        ...process.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      },
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });

    // Wait long enough that the first-boot probe would have fired.
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("memory-seed-dialog")).toBeHidden();
  });
});
