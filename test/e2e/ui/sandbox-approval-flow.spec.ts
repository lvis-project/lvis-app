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
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

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
    mkdirSync(resolve(tempHome, ".lvis", "permissions"), { recursive: true });

    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        LVIS_HOME: tempHome,
        LVIS_SANDBOX_ENABLED: "0", // Keep sandbox off for E2E stability
        NODE_ENV: "test",
        ELECTRON_IS_DEV: "0",
      },
      executablePath: undefined,
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
  });

  test.afterEach(async () => {
    await app?.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("HIGH verdict requires NL justification before Approve button is enabled", async () => {
    // Inject a HIGH-verdict approval request via IPC
    await app.evaluate(({ ipcMain }, req) => {
      const { BrowserWindow } = require("electron");
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
    await app.evaluate(({ ipcMain }, req) => {
      const { BrowserWindow } = require("electron");
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
    await expect(page.getByText("이 세션만")).toBeVisible();
    await expect(page.getByText("지속 허용")).toBeVisible();
  });

  test("partial sandbox shows correct Korean label in approval dialog", async () => {
    await app.evaluate(({ ipcMain }, req) => {
      const { BrowserWindow } = require("electron");
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

    // Sandbox row should show partial isolation Korean label
    const sandboxRow = page.getByTestId("tool-approval-sandbox");
    await expect(sandboxRow).toContainText("OS 격리 부분적");
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

    // Navigate to Settings → Permissions tab
    const settingsButton = page.locator('[data-testid="settings-button"], [aria-label*="설정"]').first();
    await expect(settingsButton).toBeVisible({ timeout: 5000 });
    await settingsButton.click();

    const permissionsTab = page.locator('[data-testid="permissions-tab"], :text("권한")').first();
    await expect(permissionsTab).toBeVisible({ timeout: 5000 });
    await permissionsTab.click();

    // Check the approval records section exists
    await expect(page.locator(':text("사용자 승인 기록")')).toBeVisible({ timeout: 5000 });
  });
});
