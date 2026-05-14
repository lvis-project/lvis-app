import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");
const ROUTINE_ID = "layout-probe";
const FIRED_AT = "2026-05-11T04:00:00.000Z";
const SESSION_FILE = "2026-05-11T04-00-00-003Z.jsonl";
const LONG_RESULT = JSON.stringify({
  query: "May 11 2026 Reuters technology AI regulation headlines",
  results: Array.from({ length: 10 }, (_, i) => ({
    title: `AI Regulation News ${i}`,
    url: `https://example.com/${"very-long-unbroken-path-segment-".repeat(24)}${i}`,
    snippet: "긴 검색 결과 본문입니다. ".repeat(20),
  })),
});
const LONG_FINAL_RESULT = [
  "## Routine result",
  "",
  "- **Summary** routine summary",
  ...Array.from({ length: 24 }, (_, i) => `- Full result line ${i + 1}: ${"visible routine result content ".repeat(5)}`),
  "",
  "<summary>routine summary</summary>",
].join("\n");

test.describe("routine session modal", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-routine-modal-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-routine-modal-home-"));
    const sessionDir = resolve(tempHome, ".lvis", "routine", "sessions", ROUTINE_ID);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(resolve(tempHome, ".lvis", "routine"), { recursive: true });
    writeFileSync(
      resolve(tempHome, ".lvis", "routine", "routines.json"),
      JSON.stringify({
        version: 2,
        routines: [
          {
            id: ROUTINE_ID,
            trigger: "schedule",
            execution: "llm-session",
            title: "Layout probe",
            createdAt: "2026-05-10T00:00:00.000Z",
            lastFiredAt: FIRED_AT,
            dismissedAt: FIRED_AT,
            schedule: { at: FIRED_AT, repeat: { kind: "none" } },
          },
        ],
      }),
      "utf-8",
    );
    writeFileSync(
      resolve(sessionDir, SESSION_FILE),
      [
        JSON.stringify({
          role: "assistant",
          content: "루틴 결과를 확인합니다.",
          toolCalls: [
            {
              id: "tool-1",
              name: "web_search",
              input: { query: "May 11 2026 Reuters technology AI regulation headlines" },
            },
          ],
        }),
        JSON.stringify({ role: "tool_result", toolName: "web_search", content: LONG_RESULT }),
        JSON.stringify({
          role: "assistant",
          content: LONG_FINAL_RESULT,
        }),
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

  test("rehydrates unacknowledged results and keeps long tool output inside the modal", async () => {
    await page.setViewportSize({ width: 560, height: 900 });
    await page.locator('[data-testid="routine-card"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await expect(page.getByText("routine summary")).toBeVisible();
    await page.locator('[data-testid="overlay-card-primary-action"]').click();
    await page.locator('[data-testid="assistant-message-body"]').filter({ hasText: "Routine result" }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await expect(page.getByText(/^Full result line 1:/)).toBeVisible();
    await expect(page.getByText("TOOL_RESULT")).toHaveCount(0);
    await expect(page.getByText("very-long-unbroken-path-segment")).toHaveCount(0);

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
      const scrollRoot = document.querySelector('[data-testid="routine-session-scroll"]') as HTMLElement | null;
      const scrollViewport = scrollRoot?.querySelector("[data-radix-scroll-area-viewport]") as HTMLElement | null;
      return {
        viewportWidth: window.innerWidth,
        docWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        dialog: box('[data-testid="routine-session-dialog"]'),
        assistantBody: box('[data-testid="assistant-message-body"]'),
        scrollViewport: scrollViewport ? {
          clientHeight: scrollViewport.clientHeight,
          scrollHeight: scrollViewport.scrollHeight,
        } : null,
      };
    });

    expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.dialog).not.toBeNull();
    expect(metrics.assistantBody).not.toBeNull();
    expect(metrics.dialog!.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.assistantBody!.right).toBeLessThanOrEqual(metrics.dialog!.right + 1);
    expect(metrics.assistantBody!.scrollWidth).toBeLessThanOrEqual(metrics.assistantBody!.clientWidth + 1);
    expect(metrics.dialog!.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(metrics.scrollViewport).not.toBeNull();
    expect(metrics.scrollViewport!.scrollHeight).toBeGreaterThan(metrics.scrollViewport!.clientHeight);
  });
});
