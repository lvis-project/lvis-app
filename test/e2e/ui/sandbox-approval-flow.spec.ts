import { buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron";
/**
 * Playwright E2E — Sandbox approval flow (PR-A4 R-2/R-3/R-4)
 *
 * Issue: #691 PR-A4
 *
 * Covers:
 *   1. HIGH verdict requires NL justification before Approve is enabled.
 *   2. LOW/MEDIUM verdict shows scope selector (session / persistent).
 *   3. Approval dialog shows correct Korean sandbox isolation label for partial.
 *   4. PermissionsTab lists user approvals and allows revocation.
 *
 * Prerequisites: `bun run build` must produce dist/src/main/main.js.
 * Tests are automatically skipped when the dist is absent (same pattern
 * as deferred-queue-modal.spec.ts).
 */
import { test, expect } from "@playwright/test";
import { makeTestT } from "./i18n";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

// Locale-agnostic UI assertions: bind `t` to the locale this spec seeds via
// buildE2eBaseSettings(true) (default "ko"). Asserting against catalog keys
// instead of hard-coded Korean lets the suite flip its seed to the English
// production default without rewriting these assertions. (#1212 follow-up.)
const t = makeTestT("ko");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApprovalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: `e2e-${Date.now()}`,
    category: "tool",
    kind: "tool",
    toolName: "bash_run",
    toolCategory: overrides.toolCategory ?? "shell",
    reviewerVerdict: overrides.reviewerVerdict ?? { level: "high", reason: "shell destructive verb" },
    args: { command: "rm -rf /tmp/test-e2e" },
    reason: "bash_run requires approval",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: true,
    sandboxCapability: overrides.sandboxCapability ?? {
      kind: "none",
      confidence: "verified",
      platform: "darwin",
      reason: "no sandbox",
    },
    ...overrides,
  };
}

// ─── Test suite ──────────────────────────────────────────────────────────────

test.describe("Sandbox approval flow", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-sandbox-approval-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-sandbox-home-"));
    writeFileSync(
      resolve(userDataDir, "lvis-settings.json"),
      JSON.stringify(buildE2eBaseSettings(true), null, 2) + "\n",
      "utf-8",
    );
    mkdirSync(resolve(tempHome, ".lvis", "permissions"), { recursive: true });

    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        LVIS_HOME: tempHome,
        LVIS_SANDBOX_ENABLED: "0", // Keep sandbox off for E2E stability
        LVIS_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_IS_DEV: "0",
      }),
      executablePath: undefined,
    });
    page = await app.firstWindow();
    // The app first loads a data: splash URL, then boots and replaces it with
    // the real index.html. Waiting only for `domcontentloaded` resolves on
    // the splash, before IPC handlers (`lvis:settings-window:open`, …) and
    // the renderer's approval listeners are wired — webContents.send / IPC
    // invocations from the test would then race against bootstrap and either
    // silently no-op or fail with "No handler registered". Wait for the
    // first persistent post-boot affordance (`[data-testid="main-toolbar"]`)
    // to match the boot gate used by `fixtures.ts`.
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
  });

  test.afterEach(async () => {
    await app?.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("HIGH verdict requires NL justification before Approve button is enabled", async () => {
    // Inject a HIGH-verdict approval request via IPC
    // Electron main-process `evaluate` is loaded as ESM in this build — the
    // CommonJS `require()` shim is not available, so use the destructured
    // `electron` arg (`BrowserWindow`) that Playwright already injects.
    await app.evaluate(({ BrowserWindow }, req) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send("lvis:approval:request", req);
    }, buildApprovalRequest({ reviewerVerdict: { level: "high", reason: "shell destructive verb" } }));

    // Dialog should appear
    const dialog = page.getByTestId("tool-approval-dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Approve button should be disabled (HIGH verdict, no NL text)
    const approveBtn = page.getByTestId("approve-button");
    await expect(approveBtn).toBeDisabled();

    // NL input should be visible
    const nlInput = page.getByTestId("nl-justification-input");
    await expect(nlInput).toBeVisible();

    // Type justification
    await nlInput.fill("테스트용 임시 파일 정리 작업입니다");

    // Now Approve should be enabled
    await expect(approveBtn).toBeEnabled();
  });

  test("LOW verdict shows scope selector and Approve is enabled without NL", async () => {
    // Electron main-process `evaluate` is loaded as ESM in this build — the
    // CommonJS `require()` shim is not available, so use the destructured
    // `electron` arg (`BrowserWindow`) that Playwright already injects.
    await app.evaluate(({ BrowserWindow }, req) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send("lvis:approval:request", req);
    }, buildApprovalRequest({
      toolCategory: "read",
      reviewerVerdict: { level: "low", reason: "read inside allowed dirs" },
    }));

    const dialog = page.getByTestId("tool-approval-dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // NL field should NOT be visible for LOW verdict
    const nlInput = page.getByTestId("nl-justification-input");
    await expect(nlInput).not.toBeVisible();

    // Approve button should be enabled immediately
    const approveBtn = page.getByTestId("approve-button");
    await expect(approveBtn).toBeEnabled();

    // Scope selector should be visible
    await expect(page.getByText(t("toolApprovalDialog.scopeSession"))).toBeVisible();
    await expect(page.getByText(t("toolApprovalDialog.scopePersistent"))).toBeVisible();
  });

  test("partial sandbox shows correct Korean label in approval dialog", async () => {
    // Electron main-process `evaluate` is loaded as ESM in this build — the
    // CommonJS `require()` shim is not available, so use the destructured
    // `electron` arg (`BrowserWindow`) that Playwright already injects.
    await app.evaluate(({ BrowserWindow }, req) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send("lvis:approval:request", req);
    }, buildApprovalRequest({
      sandboxCapability: {
        kind: "partial",
        confidence: "policy-best-effort",
        platform: "darwin",
        reason: "sandbox-exec SBPL active",
      },
    }));

    const dialog = page.getByTestId("tool-approval-dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Sandbox row should show partial isolation label
    const sandboxRow = page.getByTestId("tool-approval-sandbox");
    await expect(sandboxRow).toContainText(t("toolApprovalDialog.sandboxPartial"));
  });

  test("PermissionsTab shows user approval records section", async () => {
    // Pre-populate an approval record
    writeFileSync(
      resolve(tempHome, ".lvis", "permissions", "user-approvals.json"),
      JSON.stringify({
        approvals: {
          "bash_run::abc123::user-keyboard": {
            approvedAt: "2026-05-16T08:00:00.000Z",
            scope: "persistent",
            verdictAtApproval: "medium",
            nlJustification: null,
            revokedAt: null,
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    // Settings is now a native BrowserWindow opened via IPC (no in-DOM
    // toolbar button to scrape). Open it through `window.lvisApi` and
    // assert the permissions tab content there.
    const settingsWindowPromise = app.waitForEvent("window", { timeout: 10_000 });
    const openResult = await page.evaluate(async () => {
      const api = (window as unknown as {
        lvisApi?: { openSettingsWindow?: (tab?: string) => Promise<{ ok: boolean; error?: string }> };
      }).lvisApi;
      if (!api?.openSettingsWindow) throw new Error("window.lvisApi.openSettingsWindow unavailable");
      return api.openSettingsWindow("permissions");
    });
    if (!openResult.ok) throw new Error(openResult.error ?? "openSettingsWindow failed");
    const settingsWindow = await settingsWindowPromise;
    await settingsWindow.waitForLoadState("domcontentloaded");

    // Permissions tab is selected by initialTab; the approval records section
    // heading renders "사용자 승인 기록 ({count})". Match only the static prefix
    // (count-agnostic, as the pre-migration assertion did) so the live record
    // count can't flake the check, while staying locale-agnostic via the catalog.
    const approvalsHeadingPrefix = t("permissionsTab.approvalsTitle", { count: 0 }).split("(")[0].trim();
    await expect(
      settingsWindow.locator(`:text(${JSON.stringify(approvalsHeadingPrefix)})`),
    ).toBeVisible({ timeout: 5000 });
  });
});
