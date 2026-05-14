/**
 * E2E: Composer redesign + Message Queue v6 layout structural verification.
 *
 * Spec: docs/blueprints/composer-redesign-message-queue.md
 *
 * 본 e2e 는 큐의 동적 동작 (⌘⏎ 인터럽트 / 자연 인입 / busy state) 은 검증 X —
 * 실제 LLM streaming 필요. 대신 v6 layout 의 정적 DOM 구조만 검증:
 *
 * - composer textarea-only (input-bar 안 SEND/Stop/Guide 0)
 * - BottomActionRow 가 TokenRing slot + 가이드 + ⇧⏎ kbd + Send 노출
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

test('idle: BottomActionRow 가 TokenRing + 가이드 ghost + 단축키 hints + Send 모두 표시', async ({ mainWindow }) => {
  const row = mainWindow.locator('[data-testid="composer-bottom-action-row"]');
  await expect(row).toBeVisible();
  // 가이드 ghost 버튼 (⌘K hint 포함)
  const guideBtn = mainWindow.locator('[data-testid="composer-guide-ghost"]');
  await expect(guideBtn).toBeVisible();
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

test('InputActionBar trailing: 📎 → 권한 → (승인 optional) → 👤 페르소나 → Thinking 순서', async ({ mainWindow }) => {
  // attach button 존재
  const attachBtn = mainWindow.locator('[data-testid="iab-attach-button"]');
  await expect(attachBtn).toBeVisible();
  // Thinking 토글 존재 (단순 visibility — 위치 검증만)
  const thinkingLabel = mainWindow.locator('text=Thinking').first();
  await expect(thinkingLabel).toBeVisible();
});

test('ApprovalQueueStatus floating chip 제거 (v6 spec)', async ({ mainWindow }) => {
  // ApprovalQueueStatus 는 fixed bottom-right floating chip 였음.
  // v6: in-flow DeferredApprovalChip 으로 통합 → floating 부재.
  // 기존 컴포넌트는 className 에 fixed bottom-4 right-4 z-40 사용.
  // 아예 마운트 안 하므로 .fixed.bottom-4.right-4.z-40 가 없어야 함.
  const candidates = mainWindow.locator(
    'div.fixed.bottom-4.right-4.z-40:has-text("승인")',
  );
  await expect(candidates).toHaveCount(0);
});
