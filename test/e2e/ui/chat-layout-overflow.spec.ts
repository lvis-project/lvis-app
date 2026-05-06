import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main.js");

const LONG_ASSISTANT =
  '먼저 ken님의 “오늘(2026-05-06 KST)” 기준 할 일/마감 항목을 찾기 위해 ' +
  '`{"id":"todo_session_write","arguments":{"steps":[{"title":"개인 작업 스냅샷 확인","status":"pending"},{"title":"승인 상태 확인","status":"in_progress"}]}}` ' +
  "이제 ken님의 개인 작업 스냅샷을 맞춰 다시 시도하겠습니다. " +
  '`tool {"tool":"agent_hub_my_work_snapshot","arguments":{"includeDone":false,"long_unbroken_key":"agent_hub_list_approval_requests_agent_hub_list_inbox_agent_hub_my_work_snapshot"}}` ' +
  "승인 요청하신 도구 결과가 반환되지 않아도 레이아웃은 오른쪽으로 밀려나면 안 됩니다.";

test.describe("chat layout overflow", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-chat-layout-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-chat-layout-home-"));
    const historicalSessionId = "11111111-2222-4333-8444-555555555555";
    const activeSessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const sessionsDir = resolve(tempHome, ".lvis", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const historicalSessionPath = resolve(sessionsDir, `${historicalSessionId}.jsonl`);
    writeFileSync(
      historicalSessionPath,
      [
        JSON.stringify({
          role: "user",
          content: "사용자 ken의 오늘 할 일과 agent_hub_list_approval_requests 상태를 확인해줘.",
        }),
        JSON.stringify({ role: "assistant", content: LONG_ASSISTANT }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, `${historicalSessionId}.meta.json`),
      JSON.stringify({ title: "historical layout probe" }, null, 2),
      "utf-8",
    );
    const activeSessionPath = resolve(sessionsDir, `${activeSessionId}.jsonl`);
    writeFileSync(
      activeSessionPath,
      [
        JSON.stringify({ role: "user", content: "현재 활성 세션입니다." }),
        JSON.stringify({ role: "assistant", content: "활성 세션 응답입니다." }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, `${activeSessionId}.meta.json`),
      JSON.stringify({ title: "active probe" }, null, 2),
      "utf-8",
    );
    const now = new Date();
    const old = new Date(now.getTime() - 60_000);
    utimesSync(historicalSessionPath, old, old);
    utimesSync(activeSessionPath, now, now);

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
    await page.evaluate(async () => {
      await window.lvisApi.setApiKey("claude", "sk-e2e-layout-placeholder");
    });
    await page.reload();
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

  test("sidebar + historical stacked markdown inline code do not clip chat horizontally", async () => {
    await page.setViewportSize({ width: 624, height: 1040 });
    await page.locator('[data-testid="assistant-message-body"]').filter({ hasText: "todo_session_write" }).first().waitFor({
      state: "visible",
      timeout: 15_000,
    });

    const metrics = await page.evaluate(() => {
      const toBox = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          scrollWidth: (el as HTMLElement).scrollWidth,
          clientWidth: (el as HTMLElement).clientWidth,
        };
      };
      return {
        viewportWidth: window.innerWidth,
        docWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        userBubble: toBox([...document.querySelectorAll(".bg-message-user")].find((el) =>
          el.textContent?.includes("agent_hub_list_approval_requests"),
        ) ?? null),
        assistantBody: toBox([...document.querySelectorAll('[data-testid="assistant-message-body"]')].find((el) =>
          el.textContent?.includes("todo_session_write"),
        ) ?? null),
        composer: toBox(document.querySelector('[data-testid="composer-input-bar"]')),
      };
    });

    expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    for (const box of [metrics.userBubble, metrics.assistantBody, metrics.composer]) {
      expect(box).not.toBeNull();
      expect(box!.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
      expect(box!.scrollWidth).toBeLessThanOrEqual(box!.clientWidth + 1);
    }
  });
});
