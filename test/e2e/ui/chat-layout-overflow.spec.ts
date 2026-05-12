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

const LONG_IDENTIFIER =
  "agent_hub_list_approval_requests_agent_hub_list_inbox_agent_hub_my_work_snapshot_20260506_KST_layout_probe";

const LONG_RESULT =
  "승인 요청 없음. 결과 문자열에도 긴한국어문장과 " +
  "`inline_code_with_long_identifier_agent_hub_list_approval_requests_agent_hub_list_inbox_agent_hub_my_work_snapshot_20260506_KST_layout_probe` " +
  "이 포함됩니다. ".repeat(6);

test.describe("chat layout overflow", () => {
  test.skip(!existsSync(MAIN_ENTRY), "dist/src/main.js not built; run bun run build first");

  let app: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let tempHome: string;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(resolve(tmpdir(), "lvis-chat-layout-user-data-"));
    tempHome = mkdtempSync(resolve(tmpdir(), "lvis-chat-layout-home-"));
    const fillerSessionId = "00000000-1111-4222-8333-444444444444";
    const historicalSessionId = "11111111-2222-4333-8444-555555555555";
    const activeSessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const sessionsDir = resolve(tempHome, ".lvis", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const fillerSessionPath = resolve(sessionsDir, `${fillerSessionId}.jsonl`);
    writeFileSync(
      fillerSessionPath,
      [
        JSON.stringify({ role: "user", content: "짧은 과거 대화입니다." }),
        JSON.stringify({ role: "assistant", content: "과거 응답입니다." }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, `${fillerSessionId}.meta.json`),
      JSON.stringify({ title: "older filler" }, null, 2),
      "utf-8",
    );
    const historicalSessionPath = resolve(sessionsDir, `${historicalSessionId}.jsonl`);
    writeFileSync(
      historicalSessionPath,
      [
        JSON.stringify({
          role: "user",
          content: "사용자 ken의 오늘 할 일과 agent_hub_list_approval_requests 상태를 확인해줘.",
        }),
        JSON.stringify({
          role: "assistant",
          content: LONG_ASSISTANT,
          thought: "첫 번째 단계 계획입니다. " + LONG_IDENTIFIER,
          toolCalls: [
            {
              id: "t1",
              name: "agent_hub_list_approval_requests",
              input: {
                query: "사용자 ken의 오늘 승인 요청 상태",
                long_unbroken_key: LONG_IDENTIFIER,
              },
            },
          ],
        }),
        JSON.stringify({
          role: "tool_result",
          toolUseId: "t1",
          toolName: "agent_hub_list_approval_requests",
          content: LONG_RESULT,
        }),
        JSON.stringify({
          role: "assistant",
          content: "두 번째 중간 설명입니다. `todo_session_write` 결과를 반영합니다. " + LONG_IDENTIFIER,
          thought: "두 번째 단계 검증입니다. " + LONG_IDENTIFIER,
          toolCalls: [
            {
              id: "t2",
              name: "todo_session_write",
              input: {
                steps: [
                  { title: "개인 작업 스냅샷 확인", status: "done" },
                  { title: "승인 상태 확인", status: "done" },
                  { title: "오늘 마감 후보 정리", status: "in_progress" },
                  { title: "레이아웃 overflow 검증", status: "pending" },
                ],
              },
            },
            {
              id: "t3",
              name: "agent_hub_my_work_snapshot",
              input: { includeDone: false, long_unbroken_key: LONG_IDENTIFIER },
            },
          ],
        }),
        JSON.stringify({
          role: "tool_result",
          toolUseId: "t2",
          toolName: "todo_session_write",
          content: "5단계 업데이트 완료. " + LONG_RESULT,
        }),
        JSON.stringify({
          role: "tool_result",
          toolUseId: "t3",
          toolName: "agent_hub_my_work_snapshot",
          content: "긴 결과 본문입니다. " + LONG_RESULT,
        }),
        JSON.stringify({
          role: "assistant",
          content:
            "최종 답변입니다. 지금 화면은 WorkGroup, 긴 한국어 문장, inline code, tool result가 같은 좁은 chat column 안에 있어야 합니다.",
        }),
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
    const oldest = new Date(now.getTime() - 120_000);
    utimesSync(fillerSessionPath, oldest, oldest);
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
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
    await page.evaluate(async () => {
      await window.lvisApi.setApiKey("claude", "sk-e2e-layout-placeholder");
    });
    await page.reload();
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

  test("historical WorkGroup tools do not clip chat horizontally", async () => {
    await page.setViewportSize({ width: 560, height: 900 });
    const workGroup = page.locator("[data-wg-id]").filter({ hasText: /단계/ }).first();
    await workGroup.waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await workGroup.locator("button").first().click();
    await page.waitForTimeout(100);
    const buttons = await workGroup.locator("button").count();
    for (let i = 1; i < buttons; i++) {
      await workGroup.locator("button").nth(i).click();
    }
    await page.locator('[data-testid="composer-textarea"]').fill(
      "긴 draft 입니다. `" + LONG_IDENTIFIER + "`",
    );

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
      const sentinel = document.querySelector('[data-testid="chat-history-sentinel"]');
      const chatViewport = sentinel?.closest("[data-radix-scroll-area-viewport]");
      const chatContentWrapper = chatViewport?.firstElementChild;
      const viewportBox = toBox(chatViewport);
      const contentWrapperBox = toBox(chatContentWrapper);
      const elementBoxes = [
        ...document.querySelectorAll('[data-testid="assistant-message-body"], [data-wg-id], pre, code, [data-testid="composer-input-bar"], .bg-message-user'),
      ]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute("data-testid"),
          text: (el.textContent ?? "").slice(0, 80),
          ...toBox(el)!,
        }));
      return {
        viewportWidth: window.innerWidth,
        docWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        chatViewport: viewportBox,
        chatContentWrapper: contentWrapperBox,
        toolbar: toBox(document.querySelector('[data-testid="main-toolbar"]')),
        workGroup: toBox(document.querySelector("[data-wg-id]")),
        composer: toBox(document.querySelector('[data-testid="composer-input-bar"]')),
        overflowing: elementBoxes.filter((box) => {
          if (!viewportBox) return true;
          const outsideViewport = box.left < viewportBox.left - 1 || box.right > viewportBox.right + 1;
          const unwrappedInline = box.tag === "code" && box.scrollWidth > box.clientWidth + 1;
          return outsideViewport || unwrappedInline;
        }),
      };
    });

    expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.bodyWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    for (const box of [metrics.chatViewport, metrics.chatContentWrapper, metrics.toolbar, metrics.workGroup, metrics.composer]) {
      expect(box).not.toBeNull();
    }
    expect(metrics.chatViewport!.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.chatContentWrapper!.right).toBeLessThanOrEqual(metrics.chatViewport!.right + 1);
    expect(metrics.chatContentWrapper!.scrollWidth).toBeLessThanOrEqual(metrics.chatContentWrapper!.clientWidth + 1);
    expect(metrics.workGroup!.right).toBeLessThanOrEqual(metrics.chatViewport!.right + 1);
    expect(metrics.composer!.right).toBeLessThanOrEqual(metrics.chatViewport!.right + 1);
    expect(metrics.composer!.left).toBeGreaterThanOrEqual(metrics.chatViewport!.left - 1);
    expect(metrics.overflowing).toEqual([]);
  });
});
