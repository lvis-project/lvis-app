import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

const LONG_INPUT_SUMMARY = JSON.stringify({
  allowedPlugins: [],
  execution: "llm-session",
  notifications: {
    token: "abcdefghijklmnopqrstuvwxyz0123456789".repeat(8),
    endpoint: "https://example.invalid/really/long/path/that/must/not/stretch/the-modal",
  },
  payload:
    "routine_schedule_write_payload_with_a_very_long_unbroken_identifier_".repeat(7),
});

test.describe("deferred queue modal", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-deferred-modal-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-deferred-modal-home-"));
    const queueDir = resolve(tempHome, ".lvis", "permissions");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      resolve(queueDir, "deferred-queue.jsonl"),
      JSON.stringify({
        id: "dq-e2e-long-input",
        ts: "2026-05-11T09:00:00.000Z",
        toolName: "routine_schedule",
        source: "builtin",
        category: "write",
        inputSummary: LONG_INPUT_SUMMARY,
        verdict: { level: "high", reason: "reviewer disabled - defer all" },
        status: "pending",
      }) + "\n",
      "utf-8",
    );

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

  test("keeps long queued input inside the modal without horizontal page overflow", async () => {
    await page.setViewportSize({ width: 460, height: 840 });
    const queueButton = page.getByTestId("permission-pending-badge");
    await queueButton.waitFor({ state: "visible", timeout: 20_000 });
    await expect(queueButton).toContainText("승인 1");
    await queueButton.click();

    const dialog = page.getByTestId("deferred-queue-dialog");
    await expect(dialog).toBeVisible();
    const entry = dialog.getByTestId("deferred-entry-dq-e2e-long-input");
    await expect(entry.locator("code", { hasText: "routine_schedule" }).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: "허용" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "거부" })).toBeVisible();

    const metrics = await collectModalMetrics(page);
    expect(metrics.documentOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.dialogOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.panelOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.entryOverflowX).toBeLessThanOrEqual(1);
    expect(metrics.inputPreviewOverflowX).toBeLessThanOrEqual(1);
  });
});

async function collectModalMetrics(page: Page) {
  return page.evaluate(() => {
    const overflowX = (el: Element | null) => {
      if (!el) return 0;
      const target = el as HTMLElement;
      return Math.max(0, target.scrollWidth - target.clientWidth);
    };
    const doc = document.documentElement;
    const dialog = document.querySelector('[data-testid="deferred-queue-dialog"]');
    const panel = document.querySelector('[data-testid="deferred-queue-panel"]');
    const entry = document.querySelector('[data-testid="deferred-entry-dq-e2e-long-input"]');
    const inputPreview = document.querySelector('[data-testid="deferred-entry-input"]') ?? entry?.querySelector("pre") ?? null;
    return {
      documentOverflowX: Math.max(0, doc.scrollWidth - window.innerWidth),
      dialogOverflowX: overflowX(dialog),
      panelOverflowX: overflowX(panel),
      entryOverflowX: overflowX(entry),
      inputPreviewOverflowX: overflowX(inputPreview),
    };
  });
}
