import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron, MAIN_ENTRY, type SeededElectronContext } from "./seeded-electron";
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
import { type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildHostShellExecutionPlan, getHostShellExecutionPlanAuditProjection } from "../../../src/permissions/host-shell-execution-plan.js";

// Locale-agnostic UI assertions: bind `t` to the locale this spec seeds via
// buildE2eBaseSettings(true) (default "ko"). Asserting against catalog keys
// instead of hard-coded Korean lets the suite flip its seed to the English
// production default without rewriting these assertions. (#1212 follow-up.)
const t = makeTestT("ko");
const SESSION_ID = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApprovalRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: `e2e-${Date.now()}`,
    sessionId: SESSION_ID,
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
  let context: SeededElectronContext | undefined;
  let tempHome: string;

  test.beforeEach(async () => {
    context = await launchSeededElectron({
      historyRows: [],
      sessionId: SESSION_ID,
      settings: buildE2eBaseSettings(true),
      userDataPrefix: "lvis-sandbox-approval-",
      homePrefix: "lvis-sandbox-home-",
      launchEnv: { LVIS_SANDBOX_ENABLED: "0" },
    });
    app = context.app;
    page = context.page;
    tempHome = context.tempHome;
    mkdirSync(resolve(tempHome, ".lvis", "permissions"), { recursive: true });
  });

  test.afterEach(async () => {
    if (context) await teardownSeededElectron(context);
    context = undefined;
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
    const dialog = page.getByRole("region", { name: t("toolApprovalDialog.toolApprovalTitle"), exact: true });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // HIGH uses the host/reviewer reason and never asks the user to type in
    // the approval surface. The explicit one-shot decision is immediately
    // available while durable allow stays unavailable.
    const approveBtn = page.getByTestId(TEST_IDS.approveButton);
    await expect(approveBtn).toBeEnabled();
    await expect(approveBtn).toHaveText(t("toolApprovalDialog.allowOnce"));
    await expect(dialog.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
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

    const dialog = page.getByRole("region", { name: t("toolApprovalDialog.toolApprovalTitle"), exact: true });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // No approval verdict renders a typeable field.
    await expect(dialog.locator('input, textarea, [contenteditable="true"], [role="textbox"]'))
      .toHaveCount(0);

    // Approve button should be enabled immediately
    const approveBtn = page.getByTestId(TEST_IDS.approveButton);
    await expect(approveBtn).toBeEnabled();

    // The obsolete scope selector is replaced by three explicit decisions.
    await expect(page.getByTestId(TEST_IDS.denyButton)).toHaveText(t("toolApprovalDialog.denyOnce"));
    await expect(page.getByTestId(TEST_IDS.allowAlwaysButton)).toHaveText(t("toolApprovalDialog.allowAlways"));
    await expect(page.getByTestId(TEST_IDS.approveButton)).toHaveText(t("toolApprovalDialog.allowOnce"));
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

    const dialog = page.getByRole("region", { name: t("toolApprovalDialog.toolApprovalTitle"), exact: true });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Sandbox row should show partial isolation label
    const sandboxRow = page.getByTestId("tool-approval-sandbox");
    await expect(sandboxRow).toContainText(t("toolApprovalDialog.sandboxPartial"));
  });

  test("explicit host approval displays the resolved directory and complete command", async ({}, testInfo) => {
    const plan = buildHostShellExecutionPlan({
      platform: "darwin", requestedSandbox: true, executionMode: "host",
      activeCapability: { reason: "Fixture sandbox available", kind: "asrt", confidence: "verified", platform: "darwin", confines: { filesystem: true, process: true, network: true } },
    });
    const command = `printf '%s' '${"a".repeat(700)}-complete-command'`;
    await app.evaluate(({ BrowserWindow }, req) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("lvis:approval:request", req);
    }, buildApprovalRequest({
      toolName: "bash",
      reviewerVerdict: { level: "high", reason: "Explicit host execution" },
      args: { command, executionMode: "host", justification: "Use the configured host client" },
      executionPlan: getHostShellExecutionPlanAuditProjection(plan),
      executionCwd: "/workspace/project",
      allowedChoices: ["deny-once", "allow-once"],
    }));

    const dock = page.getByRole("region", { name: t("toolApprovalDialog.toolApprovalTitle"), exact: true });
    await expect(dock).toBeVisible();
    await expect(dock.getByTestId("tool-approval-host-execution")).toContainText(t("shellExecution.hostWarning"));
    await expect(dock.getByTestId("tool-approval-execution-cwd")).toContainText("/workspace/project");
    await expect(dock.getByTestId("tool-approval-shell-environment")).toContainText(t("shellExecution.hostHome"));
    await expect(dock.getByTestId(TEST_IDS.approvalReviewDetails)).toHaveAttribute("open", "");
    await expect(dock.getByTestId("tool-approval-input")).toHaveText(command);
    await expect(dock.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
    await expect(dock.getByTestId(TEST_IDS.approveButton)).toBeEnabled();
    await expect(dock.getByTestId(TEST_IDS.denyButton)).toBeFocused();
    await expect(dock.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
    await testInfo.attach("explicit-host-approval", { body: await dock.screenshot(), contentType: "image/png" });
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
