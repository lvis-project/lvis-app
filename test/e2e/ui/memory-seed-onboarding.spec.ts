import { buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron";
/**
 * Tutorial-B (O-X2) — Memory Seed Onboarding Wizard e2e.
 *
 * Verifies the first-boot funnel:
 *   1. Fresh HOME (`features.onboardingCompleted=false`, no API keys)
 *      starts at ScenarioShowcase and then opens MemorySeed.
 *   2. The scenario choice opens MemorySeed directly.
 *   3. Filling in 호칭 + 자기소개 → "기억하고 시작하기" dismisses the
 *      wizard and seeds `~/.lvis/memories/MEMORY.md` Urgent Memory.
 *   4. PersonalizedWelcome advances to SpotlightTour via the Z chain-effect.
 *   5. Subsequent boots do NOT re-show the wizard
 *      (`features.onboardingCompleted` flipped).
 */
import { test, expect } from "@playwright/test";
import { makeTestT } from "./i18n";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

// Locale-agnostic UI assertions: bind `t` to the locale this spec seeds via
// buildE2eBaseSettings(false) (default "ko"). Asserting against catalog keys
// instead of hard-coded Korean lets the suite flip its seed to the English
// production default without rewriting these assertions. (#1212 follow-up.)
const t = makeTestT("ko");

test.describe("memory seed onboarding wizard", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;
  let lvisHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-memory-seed-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-memory-seed-home-"));
    writeFileSync(
      resolve(userDataDir, "lvis-settings.json"),
      JSON.stringify(buildE2eBaseSettings(false), null, 2) + "\n",
      "utf-8",
    );
    lvisHome = resolve(tempHome, ".lvis");

    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        LVIS_HOME: lvisHome,
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        LVIS_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
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

  async function advanceToMemorySeed() {
    const showcase = page.getByTestId("scenario-showcase");
    await expect(showcase).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("scenario-showcase:start").click();

    const dialog = page.getByTestId("memory-seed-dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    return dialog;
  }

  async function completeOnboardingAfterMemory(options?: {
    expectedGreeting?: string;
    expectedIntro?: string;
  }) {
    const welcome = page.getByTestId("personalized-welcome");
    await expect(welcome).toBeVisible({ timeout: 10_000 });
    if (options?.expectedGreeting) {
      await expect(welcome.getByTestId("personalized-welcome:greeting")).toContainText(
        options.expectedGreeting,
      );
    }
    if (options?.expectedIntro) {
      await expect(welcome.getByTestId("personalized-welcome:intro")).toContainText(
        options.expectedIntro,
      );
    }
    await welcome.getByTestId("personalized-welcome:continue").click();
    await expect(welcome).toBeHidden({ timeout: 10_000 });

    const tour = page.getByTestId("spotlight-tour");
    const tourCard = page.getByTestId("spotlight-tour:card");
    await expect(tourCard).toBeVisible({ timeout: 10_000 });
    await expect(tour).toHaveAttribute("data-scenario-id", "first-boot-essentials");

    const nextButton = page.getByTestId("spotlight-tour:next");
    for (let step = 0; step < 12; step += 1) {
      if (!(await tourCard.isVisible().catch(() => false))) break;
      await nextButton.click();
      await page.waitForTimeout(150);
    }
    await expect(tourCard).toBeHidden({ timeout: 10_000 });

    // Plugin discovery stays in Marketplace/Settings instead of blocking the
    // end of the first-run flow with another modal.
    await expect(page.getByTestId("plugin-showcase")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const api = (window as unknown as {
              lvisApi: { getSettings: () => Promise<{ features?: { onboardingCompleted?: boolean } }> };
            }).lvisApi;
            const settings = await api.getSettings();
            return settings.features?.onboardingCompleted;
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
  }

  test("auto-opens on first boot, seeds MEMORY.md, and the chain-effect tour broadcast mounts the SpotlightTour", async () => {
    await page.setViewportSize({ width: 460, height: 840 });

    const dialog = await advanceToMemorySeed();

    await dialog.getByTestId("memory-seed-dialog:name").fill("Ken");
    await dialog
      .getByTestId("memory-seed-dialog:intro")
      .fill("매주 회의가 많은 PM. 회의록 정리와 일정 관리 자동화에 관심.");

    // Live chip recomputation: meeting + ms-graph keywords are present.
    await expect(dialog.getByTestId("memory-seed-dialog:chip:meeting")).toBeVisible();
    await expect(dialog.getByTestId("memory-seed-dialog:chip:ms-graph")).toBeVisible();

    await dialog.getByTestId("memory-seed-dialog:submit").click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    // The chain must carry MemorySeed values into PersonalizedWelcome before
    // the tour broadcast can mark onboarding complete.
    await completeOnboardingAfterMemory({
      expectedGreeting: "Ken",
      expectedIntro: "매주 회의가 많은 PM",
    });

    // MEMORY.md should now carry both 호칭 + 자기소개 lines in Urgent Memory.
    const memoryPath = resolve(tempHome, ".lvis", "memories", "MEMORY.md");
    await expect.poll(() => existsSync(memoryPath), { timeout: 5_000 }).toBe(true);
    const md = readFileSync(memoryPath, "utf-8");
    expect(md).toContain("호칭: Ken");
    expect(md).toContain("자기소개: 매주 회의가 많은 PM");
  });

  test("does not re-open on the second boot once onboarding is completed", async () => {
    // First boot: advance through ScenarioShowcase, then dismiss MemorySeed via skip.
    const dialog = await advanceToMemorySeed();
    await dialog.getByTestId("memory-seed-dialog:skip").click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await completeOnboardingAfterMemory();

    // Close and re-launch with the same HOME — completed onboarding must not reopen.
    await app.close().catch(() => {});
    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        LVIS_HOME: lvisHome,
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        LVIS_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });

    // Wait long enough that the first-boot probe would have fired.
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("scenario-showcase")).toHaveCount(0);
    await expect(page.getByTestId("memory-seed-dialog")).toHaveCount(0);
  });
});
