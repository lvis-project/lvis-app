/**
 * Pre-release verification for the docked approval card (#1973, unified
 * frame #2104).
 *
 * It landed with unit coverage only. The failure mode unit tests cannot see is
 * a wiring one: the dock is mounted once by App beside the routed content, and
 * if it never mounts every tool call needing an approval times out into a deny
 * and the app looks dead. So this drives the real
 * Electron build, pushes a real approval request down the real IPC channel,
 * and asserts the card is on screen, keyboard-driven, and that its target line
 * tracks the focused scope — the property the whole design rests on.
 */
import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  MAIN_ENTRY,
  builtMainExists,
  buildE2eBaseSettings,
  buildIsolatedElectronEnv,
} from "./seeded-electron.js";

const OUT_OF_DIR_REQUEST = {
  id: "release-check-1",
  category: "tool",
  kind: "out-of-allowed-dir",
  allowedChoices: ["allow-once", "allow-always", "deny-once"],
  toolName: "read_file",
  toolCategory: "read",
  args: { path: "C:/ProgramData/lvis/config.json" },
  reason: "release check",
  source: "builtin",
  createdAt: Date.now(),
  requireExplicit: false,
  target: { filePath: "C:/ProgramData/lvis/config.json" },
  outOfAllowedDir: {
    candidatePath: "C:/ProgramData/lvis/config.json",
    suggestedParent: "C:/ProgramData/lvis",
    currentAllowed: ["C:/work"],
    adjacencyWarnings: [],
  },
};

test.describe("release check — docked approval card", () => {
  test.skip(!builtMainExists(), "dist not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    const userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-rel-approval-ud-"));
    const tempHome = mkdtempSync(resolve(tmpdir(), "lvis-rel-approval-home-"));
    writeFileSync(
      resolve(userDataDir, "lvis-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true, "ko"), null, 2),
      "utf-8",
    );
    // The app blocks on "Loading user settings and memory..." until a session
    // exists, so seed one; without it ChatView never mounts and nothing below
    // can be observed.
    const sessionId = "abcdabcd-1111-4222-8333-444444444444";
    const sessionsDir = resolve(tempHome, ".lvis", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      resolve(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({ role: "user", content: "릴리스 점검" }),
        JSON.stringify({ role: "assistant", content: "확인했습니다." }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, `${sessionId}.meta.json`),
      JSON.stringify({ title: "release check" }, null, 2),
      "utf-8",
    );

    app = await electron.launch({
      // Isolate Chromium's profile before app startup. LVIS_USER_DATA_DIR is
      // also passed for the app's own settings, but that environment variable
      // alone is too late to prevent Electron's process-singleton lock from
      // colliding with the canonical app intentionally left open for CDP.
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        LVIS_HOME: tempHome,
        LVIS_USER_DATA_DIR: userDataDir,
        LVIS_DEV: "1",
        LVIS_E2E: "1",
        LVIS_MAIN_ENTRY: MAIN_ENTRY,
      }) as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({ timeout: 30_000 });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
  });

  test("boots with no renderer error", async () => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await expect(page.locator("body")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    expect(errors, `renderer threw: ${errors.join(" | ")}`).toEqual([]);
  });

  test("a real approval request mounts the card, and the target tracks focus", async () => {
    await expect(page.locator("body")).toBeVisible({ timeout: 30_000 });

    // The renderer subscribes on mount; give React a beat, then push a genuine
    // request down the real channel from main. Resend a few times so a slow
    // first paint does not read as a wiring failure.
    const bridgeReady = await page.evaluate(
      () => typeof (window as any).lvis?.approval?.onRequest === "function",
    );
    expect(bridgeReady, "preload approval bridge missing").toBe(true);

    // Prove the event reaches the renderer before blaming the card. Without
    // this, a boot that stalls before ChatView mounts reads as a wiring defect
    // in the card itself.
    await page.evaluate(() => {
      (window as any).__relSeen = [];
      (window as any).lvis.approval.onRequest((r: unknown) => {
        (window as any).__relSeen.push(r);
      });
    });

    const overlay = page.getByTestId("approval-dock");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.evaluate(({ BrowserWindow }, payload) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.webContents.send("lvis:approval:request", payload);
      }, { ...OUT_OF_DIR_REQUEST, id: `release-check-${attempt}` });
      if (await overlay.count()) break;
      await page.waitForTimeout(1_000);
    }
    const seen = await page.evaluate(() => (window as any).__relSeen ?? []);
    expect(seen.length, "renderer never received the approval event").toBeGreaterThan(0);
    const kinds = await page.evaluate(() =>
      ((window as any).__relSeen ?? []).map((r: any) => r?.kind));
    expect(kinds, "kind did not survive the IPC hop").toContain("out-of-allowed-dir");

    await expect(overlay).toBeVisible({ timeout: 10_000 });

    const target = page.getByTestId("approval-decision-target");
    await expect(target).toBeVisible();
    const firstTarget = ((await target.textContent()) ?? "").trim();
    expect(firstTarget.length).toBeGreaterThan(0);

    // Every decision must be rendered as its own button — the same three
    // buttons every other approval kind renders (one frame, issue #2104).
    for (const testId of ["deny-button", "allow-always-button", "approve-button"]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }

    // The dock hands keyboard focus to the fail-closed Reject decision on
    // arrival, so a pending Enter/Space from the covered composer can never
    // become an accidental approval.
    await expect
      .poll(async () => page.evaluate(() => {
        const el = document.activeElement;
        return !!el?.closest('[data-testid="approval-dock"]');
      }), { timeout: 5_000 })
      .toBe(true);

    await page.getByTestId("approve-button").focus();

    // Arrowing must move focus AND rewrite the target line. This is the
    // property the design rests on: what will be granted is always on screen.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => ((await target.textContent()) ?? "").trim(), { timeout: 5_000 })
      .not.toBe(firstTarget);

    const afterArrow = ((await target.textContent()) ?? "").trim();
    expect(afterArrow, "allow-always must name the parent folder").toContain("C:/ProgramData/lvis");
  });
});
