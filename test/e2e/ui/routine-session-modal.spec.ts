import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main.js");
const ROUTINE_ID = "layout-probe";
const FIRED_AT = "2026-05-11T04:00:00.000Z";
const SESSION_FILE = "2026-05-11T04-00-00-000Z.jsonl";
const LONG_RESULT = JSON.stringify({
  query: "May 11 2026 Reuters technology AI regulation headlines",
  results: Array.from({ length: 10 }, (_, i) => ({
    title: `AI Regulation News ${i}`,
    url: `https://example.com/${"very-long-unbroken-path-segment-".repeat(24)}${i}`,
    snippet: "긴 검색 결과 본문입니다. ".repeat(20),
  })),
});

test.describe("routine session modal", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-routine-modal-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-routine-modal-home-"));
    const sessionDir = resolve(tempHome, ".lvis", "routine", "sessions", ROUTINE_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      resolve(sessionDir, SESSION_FILE),
      [
        JSON.stringify({ role: "assistant", content: "루틴 결과를 확인합니다." }),
        JSON.stringify({ role: "tool_result", toolName: "web_search", content: LONG_RESULT }),
      ].join("\n") + "\n",
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
    await page.locator('[data-testid="sidebar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  test("keeps long LLM tool results inside the routine result modal", async () => {
    await page.setViewportSize({ width: 560, height: 900 });
    await app.evaluate(({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("lvis:routines:v2:fired", payload);
    }, {
      id: ROUTINE_ID,
      trigger: "schedule",
      firedAt: FIRED_AT,
      title: "Layout probe",
      summary: "routine summary",
      routineSessionPath: "present",
    });

    await page.locator('[data-testid="routine-card"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.locator('[data-testid="overlay-card-primary-action"]').click();
    await page.locator('[data-testid="routine-session-tool-result"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });

    const metrics = await page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector) as HTMLElement | null;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const backgroundColor = window.getComputedStyle(el).backgroundColor;
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          backgroundColor,
        };
      };
      return {
        viewportWidth: window.innerWidth,
        docWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        dialog: box('[data-testid="routine-session-dialog"]'),
        toolResult: box('[data-testid="routine-session-tool-result"]'),
      };
    });

    expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.dialog).not.toBeNull();
    expect(metrics.toolResult).not.toBeNull();
    expect(metrics.dialog!.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.toolResult!.right).toBeLessThanOrEqual(metrics.dialog!.right + 1);
    expect(metrics.toolResult!.scrollWidth).toBeLessThanOrEqual(metrics.toolResult!.clientWidth + 1);
    expect(metrics.dialog!.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });
});
