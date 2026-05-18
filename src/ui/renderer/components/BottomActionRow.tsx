/**
 * BottomActionRow — composer 하단 row.
 *
 * v6 layout: TOP ROW (환경 컨트롤) ↔ BOTTOM ROW (Turn 컨트롤) 분리.
 * 본 컴포넌트는 BOTTOM ROW 전체를 담당:
 *
 *   info cluster (좌, grow):
 *     [○ TokenRing $] [⇧⏎ 줄바꿈] [⌘⏎ 즉시(busy)]
 *
 *   actions cluster (우):
 *     [■ 취소(busy, 컴팩트 원형 stop)] [↑ 전송 ⏎]
 *
 * Send 버튼 라벨은 isBusy 상관없이 항상 "전송" 으로 고정. 큐 인입 시맨틱은
 * textarea placeholder ("메시지 큐에 추가됩니다 ...") 와 ⌘⏎ hint 로 표현해
 * 버튼이 두 줄로 줄바꿈되는 레이아웃 깨짐을 방지.
 *
 * Spec: docs/blueprints/composer-redesign-message-queue.md
 */

import type { ReactNode } from "react";
import { Square } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";

export interface BottomActionRowProps {
  /** TokenProgressRing + cost badge 슬롯. ChatView 가 합성해서 주입. */
  tokenSlot: ReactNode;
  /** LLM busy (streaming/도구 실행 등) 여부. Send 라벨/취소 노출 결정. */
  isBusy: boolean;
  /** Send 버튼 disable 결정 — text 비고 첨부 없으면 true. */
  isSendDisabled: boolean;
  /** Send 버튼 클릭 (= Enter 와 동등). intent 캡처는 caller. */
  onSend: () => void;
  /** ESC 취소 = LLM abort (큐 보존). LLM busy 일 때만 노출. */
  onCancel: () => void;
}

export function BottomActionRow({
  tokenSlot,
  isBusy,
  isSendDisabled,
  onSend,
  onCancel,
}: BottomActionRowProps) {
  return (
    <div
      data-testid="composer-bottom-action-row"
      className="flex flex-wrap items-center gap-3 px-3 pt-1 pb-2"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {tokenSlot}
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Kbd>⇧⏎</Kbd>
          <span>줄바꿈</span>
        </span>
        {isBusy && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
            data-testid="composer-hint-immediate"
          >
            <Kbd>⌘⏎</Kbd>
            <span>즉시 주입</span>
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isBusy && (
          <button
            type="button"
            onClick={onCancel}
            data-testid="composer-cancel-button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
            title="LLM 취소 (ESC)"
            aria-label="LLM 취소 (ESC)"
          >
            <Square className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
          </button>
        )}
        <Button
          type="button"
          onClick={onSend}
          disabled={isSendDisabled}
          data-testid="composer-send-button"
          className="inline-flex h-7 items-center gap-1.5 px-3 text-xs font-semibold"
        >
          <span>전송</span>
          <KbdInverse>⏎</KbdInverse>
        </Button>
      </div>
    </div>
  );
}

/**
 * Helper to capture user keyboard intent snapshot from window.lvisApi.
 * BottomActionRow 자체는 intent 모름 → caller 가 wrap.
 */
export function makeBottomActionSendHandler(
  baseSend: (intent: UserKeyboardIntentSnapshot) => void,
): () => void {
  return () => {
    const api = (globalThis as typeof globalThis & {
      window?: { lvisApi?: { captureUserKeyboardIntent?: () => UserKeyboardIntentSnapshot } };
    }).window?.lvisApi;
    const intent = api?.captureUserKeyboardIntent?.() ?? {
      inputOrigin: "user-keyboard",
      token: "",
    };
    baseSend(intent);
  };
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-border border-b-2 bg-muted px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

function KbdInverse({ children }: { children: ReactNode }) {
  // theme tokens 만 사용 (theme-snapshot.test.tsx 가 black/white 직접 참조 금지).
  // primary 배경 위 kbd 라 primary-foreground 의 sub-opacity 토큰으로 표현.
  return (
    <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-primary-foreground/30 border-b-2 bg-primary-foreground/15 px-1 font-mono text-[10px] text-primary-foreground">
      {children}
    </kbd>
  );
}
