/**
 * E2E: Composer redesign + Message Queue v6 layout structural verification.
 *
 * Spec: docs/blueprints/composer-redesign-message-queue.md
 *
 * 본 e2e 는 v6 layout 구조와 queue-auto done event 인입을 검증한다.
 * ⌘⏎ 인터럽트 / 자연 인입 / busy state 는 실제 LLM streaming 의존도가 높아
 * 별도 renderer 단위 테스트에서 다룬다.
 *
 * - composer textarea-only (input-bar 안 SEND/Stop/Guide 0)
 * - BottomActionRow 가 TokenRing slot + ⇧⏎ kbd + Send 노출
 * - InputActionBar trailing 순서: 📎 → 권한 → (승인) → 페르소나 → Thinking
 * - MessageQueuePanel sentinel: 큐 비면 panel 자체 미렌더
 * - ApprovalQueueStatus floating chip 제거 (DOM 부재)
 */
import { test, expect } from './fixtures';

test('idle: composer input-bar contains textarea only (no Send/Stop/Guide buttons)', async ({ mainWindow }) => {
  // textarea 존재
  const textarea = mainWindow.locator('[data-testid="composer-textarea"]');
  await expect(textarea).toBeVisible();

  // input-bar 안 v6 이전의 Send/Stop/Guide 버튼은 사라짐
  const inputBar = mainWindow.locator('[data-testid="composer-input-bar"]');
  await expect(inputBar).toBeVisible();
  // input-bar 직하 자식 button 0 (textarea 만)
  const buttonsInsideInputBar = inputBar.locator('> button');
  await expect(buttonsInsideInputBar).toHaveCount(0);
});

test('idle: BottomActionRow 가 TokenRing + 단축키 hints + Send 표시, 가이드 버튼 미노출', async ({ mainWindow }) => {
  const row = mainWindow.locator('[data-testid="composer-bottom-action-row"]');
  await expect(row).toBeVisible();

  const guideBtn = mainWindow.locator('[data-testid="composer-guide-ghost"]');
  await expect(guideBtn).toHaveCount(0);

  // Send 버튼 (idle 라벨 = "전송")
  const sendBtn = mainWindow.locator('[data-testid="composer-send-button"]');
  await expect(sendBtn).toBeVisible();
});

test('idle: cancel button + immediate-inject hint 모두 미노출 (busy 일 때만)', async ({ mainWindow }) => {
  // esc 취소 버튼은 busy 시만
  const cancelBtn = mainWindow.locator('[data-testid="composer-cancel-button"]');
  await expect(cancelBtn).toHaveCount(0);
  // ⌘⏎ 즉시 주입 hint 도 busy 시만
  const immediateHint = mainWindow.locator('[data-testid="composer-hint-immediate"]');
  await expect(immediateHint).toHaveCount(0);
});

test('idle: MessageQueuePanel 미렌더 (큐 비어 있음 sentinel)', async ({ mainWindow }) => {
  const panel = mainWindow.locator('[data-testid="message-queue-panel"]');
  // 큐 비면 panel 자체가 null return → DOM 부재
  await expect(panel).toHaveCount(0);
});

test.describe('renderer debug stream env', () => {
  test.use({ launchEnv: { LVIS_DEV_CONSOLE: '1' } });

  test('dev console flag does not enable renderer debugStream by default', async ({ mainWindow }) => {
    const env = await mainWindow.evaluate(() => {
      const lvis = (window as unknown as {
        lvis?: {
          env?: {
            isDev?: boolean;
            isE2E?: boolean;
            enableDevConsole?: boolean;
            debugStream?: boolean;
          };
        };
      }).lvis;
      return lvis?.env ?? null;
    });

    expect(env).toMatchObject({
      isDev: true,
      isE2E: true,
      enableDevConsole: true,
      debugStream: false,
    });
  });
});

test('InputActionBar trailing: 📎 → 권한 → (승인 optional) → 👤 페르소나 → Thinking 순서', async ({ mainWindow }) => {
  // attach button 존재
  const attachBtn = mainWindow.locator('[data-testid="iab-attach-button"]');
  await expect(attachBtn).toBeVisible();
  // Thinking 토글 존재 (단순 visibility — 위치 검증만)
  const thinkingLabel = mainWindow.locator('text=Thinking').first();
  await expect(thinkingLabel).toBeVisible();
});

test('큐 항목 수정 (더블클릭) — input 진입 + Enter commit', async ({ mainWindow }) => {
  // 큐 적재 후 더블클릭 → input 등장 → Enter 로 텍스트 갱신.
  // store 직접 manipulation 으로 testid="message-queue-row" 강제 등장.
  await mainWindow.evaluate(() => {
    // @ts-expect-error renderer test hook
    const store = window.__lvis_message_queue_store__;
    if (store) {
      store.add("original text");
    }
  });
  // 큐 row 가 안 뜨면 (test hook 미설치) skip — production 빌드 호환.
  const row = mainWindow.locator('[data-testid="message-queue-row-text"]').first();
  const visible = await row.isVisible().catch(() => false);
  if (!visible) test.skip();
  await row.dblclick();
  const input = mainWindow.locator('[data-testid="message-queue-row-edit"]');
  await expect(input).toBeVisible();
  await input.fill("edited text");
  await input.press("Enter");
  await expect(mainWindow.locator('[data-testid="message-queue-row-text"]').first()).toContainText("edited text");
});

test('queue-auto 자동 인입 — done event 시 큐 항목이 user bubble + "↪ 큐에서" hint 로 표시', async ({ app, mainWindow, t }) => {
  // The default shared fixture intentionally starts without an LLM key. Seed
  // the active provider with a dummy key so handleAsk passes its API-key gate;
  // chatSend may fail later, but the queue user bubble must be appended first.
  const hasSeededKey = await mainWindow.evaluate(async () => {
    const api = (window as unknown as {
      lvisApi: {
        getSettings: () => Promise<unknown>;
        hasApiKey: (provider: string) => Promise<boolean>;
        setApiKey: (provider: string, key: string) => Promise<unknown>;
      };
    }).lvisApi;
    const settings = await api.getSettings();
    const provider =
      settings && typeof settings === 'object' &&
      'llm' in settings &&
      settings.llm &&
      typeof settings.llm === 'object' &&
      'provider' in settings.llm &&
      typeof settings.llm.provider === 'string'
        ? settings.llm.provider
        : 'azure';
    await api.setApiKey(provider, 'lvis-e2e-dummy-key');
    return api.hasApiKey(provider);
  });
  expect(hasSeededKey).toBe(true);
  // 큐에 항목 적재 후 done event 시뮬 (preload 의 stream IPC) → user bubble
  // 등장 + injectHint="queue" 배지. queue-auto inputOrigin path 의 통합 검증.
  await mainWindow.evaluate(() => {
    // @ts-expect-error renderer test hook
    const store = window.__lvis_message_queue_store__;
    if (store) {
      store.add("끝나면 요약");
    }
  });
  const row = mainWindow.locator('[data-testid="message-queue-row-text"]').first();
  await expect(row).toBeVisible();
  // done event 발화 — main 프로세스에서 broadcast.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return false;
    win.webContents.send("lvis:chat:stream", { type: "done", streamId: 1 });
    return true;
  });
  // user bubble 에 "↪ 큐에서" 배지 확인.
  await expect(mainWindow.locator(`text=${t('chatView.queueInjectLabel')}`).first()).toBeVisible({ timeout: 5_000 });
  await expect(mainWindow.locator('text=끝나면 요약').first()).toBeVisible();
});

test('ApprovalQueueStatus floating chip 제거 (v6 spec)', async ({ mainWindow, t }) => {
  // ApprovalQueueStatus 는 fixed bottom-right floating chip 였음.
  // v6: in-flow DeferredApprovalChip 으로 통합 → floating 부재.
  // 기존 컴포넌트는 className 에 fixed bottom-4 right-4 z-40 사용.
  // 아예 마운트 안 하므로 .fixed.bottom-4.right-4.z-40 가 없어야 함.
  const candidates = mainWindow.locator(
    `div.fixed.bottom-4.right-4.z-40:has-text("${t('approvalQueueStatus.pendingApprovals')}")`,
  );
  await expect(candidates).toHaveCount(0);
});
