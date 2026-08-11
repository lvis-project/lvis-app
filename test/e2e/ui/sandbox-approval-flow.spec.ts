import { buildE2eBaseSettings, buildIsolatedElectronEnv } from "./seeded-electron";
/**
 * Playwright E2E — Sandbox approval flow (PR-A4 R-2/R-3/R-4)
 *
 * Issue: #691 PR-A4
 *
 * Covers:
 *   1. HIGH verdict requires NL justification before Approve is enabled.
 *   2. LOW/MEDIUM verdict shows scope selector (session / persistent).
 *   3. Approval dock shows correct Korean sandbox isolation label for partial.
 *   4. PermissionsTab lists user approvals and allows revocation.
 *
 * Prerequisites: `bun run build` must produce dist/src/main/main.js.
 * Tests are automatically skipped when the dist is absent (same pattern
 * as deferred-queue-modal.spec.ts).
 */
import { test, expect } from "@playwright/test";
import { makeTestT } from "./i18n";
import { openInlineSettings } from "./inline-settings.js";
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
    // the splash, before IPC handlers and
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

  test("HIGH verdict shows a read-only audit reason and requires explicit Allow once", async () => {
    // Inject a HIGH-verdict approval request via IPC
    // Electron main-process `evaluate` is loaded as ESM in this build — the
    // CommonJS `require()` shim is not available, so use the destructured
    // `electron` arg (`BrowserWindow`) that Playwright already injects.
    await app.evaluate(({ BrowserWindow }, req) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send("lvis:approval:request", req);
    }, buildApprovalRequest({ reviewerVerdict: { level: "high", reason: "shell destructive verb" } }));

    // Dialog should appear
    const dialog = page.getByTestId("approval-dock");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // HIGH uses the host/reviewer reason and never asks the user to type in
    // the approval surface. The explicit one-shot decision is immediately
    // available while durable allow stays unavailable.
    const approveBtn = page.getByTestId("approve-button");
    await expect(approveBtn).toBeEnabled();
    await expect(approveBtn).toHaveText(t("toolApprovalDialog.allowOnce"));
    await expect(dialog.getByTestId("allow-always-button")).toBeDisabled();
    await expect(dialog.getByTestId("high-risk-audit-reason"))
      .toContainText("shell destructive verb");
    await expect(dialog.locator('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toHaveCount(0);
  });

  test("LOW verdict shows exactly three decisions and Allow once is enabled without NL", async () => {
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

    const dialog = page.getByTestId("approval-dock");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // No approval verdict renders a typeable field.
    await expect(dialog.locator('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toHaveCount(0);

    // Approve button should be enabled immediately
    const approveBtn = page.getByTestId("approve-button");
    await expect(approveBtn).toBeEnabled();

    // The obsolete scope selector is replaced by three explicit decisions.
    await expect(page.getByTestId("deny-button")).toHaveText(t("toolApprovalDialog.denyOnce"));
    await expect(page.getByTestId("allow-always-button")).toHaveText(t("toolApprovalDialog.allowAlways"));
    await expect(page.getByTestId("approve-button")).toHaveText(t("toolApprovalDialog.allowOnce"));
  });

  test("partial sandbox shows correct Korean label in approval dock", async () => {
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

    const dialog = page.getByTestId("approval-dock");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Sandbox row should show partial isolation label
    const sandboxRow = page.getByTestId("tool-approval-sandbox");
    await expect(sandboxRow).toContainText(t("toolApprovalDialog.sandboxPartial"));
  });

  test("PermissionsTab shows the exact permission decisions section", async () => {
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

    const settingsPage = await openInlineSettings(app, page, "permissions");

    // Permissions tab is selected by initialTab. Match the first section title
    // rather than the empty-state copy, which deliberately shares the same
    // exact-decision phrase.
    const approvalsHeadingPrefix = t("permissionsTab.approvalsTitle", { count: 0 }).split("(")[0].trim();
    await expect(
      settingsPage.locator(`:text(${JSON.stringify(approvalsHeadingPrefix)})`).first(),
    ).toBeVisible({ timeout: 5000 });
  });
});
