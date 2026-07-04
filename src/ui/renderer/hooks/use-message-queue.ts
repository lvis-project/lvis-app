import { useCallback, useEffect, useMemo, useRef } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  MessageQueueStore,
  formatQueueInject,
  type MessageQueueItem,
} from "../state/message-queue-store.js";
import type { Attachment } from "../types/attachments.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { LvisApi } from "../types.js";

export interface UseMessageQueueParams {
  api: LvisApi;
  currentSessionId: string;
  question: string;
  attachments: Attachment[];
  streaming: boolean;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onAsk: (
    q: string,
    intent?: UserKeyboardIntentSnapshot,
    opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
  ) => void | Promise<void>;
  onGuide: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onGuideError: (message: string) => void;
  onAbort: () => void | Promise<void>;
}

export interface UseMessageQueueResult {
  messageQueueStore: MessageQueueStore;
  handleComposerSend: (intent: UserKeyboardIntentSnapshot) => void;
  handleMessageQueueSendNow: (item: MessageQueueItem) => void;
  flushQueueAsUserMessage: () => void;
}

/**
 * Owns the mid-turn message queue: the per-view store (+ dev/e2e window hook +
 * session-change clear), the stream brake-point drains (tool_end → onGuide,
 * done → queue-auto onAsk with re-entrancy guard), and the composer/streaming
 * keyboard flows (Enter morph, ESC inject-or-abort, ⌘⏎ immediate inject, ⌘K
 * guide). Keyboard/effect dependency arrays are preserved byte-identically.
 */
export function useMessageQueue({
  api,
  currentSessionId,
  question,
  attachments,
  streaming,
  setQuestion,
  setAttachments,
  onAsk,
  onGuide,
  onGuideError,
  onAbort,
}: UseMessageQueueParams): UseMessageQueueResult {
  const { t } = useTranslation();


  const messageQueueStore = useMemo(() => new MessageQueueStore(), []);

  const queueAutoInflightRef = useRef(false);

  // dev/e2e runtime test hook — Playwright launches production-built renderer
  // assets, so this must use preload runtime env instead of build-time NODE_ENV.
  useEffect(() => {
    const w = window as unknown as {
      __lvis_message_queue_store__?: MessageQueueStore;
      lvis?: { env?: { isDev?: boolean; isE2E?: boolean } };
    };
    if (w.lvis?.env?.isDev === true && w.lvis?.env?.isE2E === true) {
      w.__lvis_message_queue_store__ = messageQueueStore;
    }
    return () => {
      if (w.__lvis_message_queue_store__ === messageQueueStore) {
        delete w.__lvis_message_queue_store__;
      }
    };
  }, [messageQueueStore]);
  useEffect(() => {
    messageQueueStore.clear();
  }, [currentSessionId, messageQueueStore]);



  //


  //


  const flushQueueViaGuide = useCallback(() => {
    if (messageQueueStore.size() === 0) return;
    const taken = messageQueueStore.takeAll();
    if (taken.length === 0) return;
    const formatted = formatQueueInject(taken);
    void (async () => {
      const result = await onGuide(formatted);
      if (result?.ok !== true) {
        const reason = result?.error ?? "unknown";
        const count = taken.length;
        const reasonLabel =
          reason === "queue-full" ? t("chatView.queueFlushFailReasonFull") :
          reason === "too-long" ? t("chatView.queueFlushFailReasonTooLong") :
          reason === "no-active-turn" ? t("chatView.queueFlushFailReasonNoTurn") :
          `(${reason})`;
        // Surface a user-visible error so the lost messages don't disappear
        // silently. Re-add is intentionally avoided to prevent infinite-retry
        // cascade — the user can re-type if they want to retry.
        onGuideError(t("chatView.queueFlushFailMessage", { count, reasonLabel }));
        console.warn(`[message-queue] guide flush dropped (${reason}):`, formatted.slice(0, 80));
      }
    })();
  }, [messageQueueStore, onGuide, onGuideError]);

  useEffect(() => {
    const unsub = api.onChatStream((ev) => {
      if (ev.type === "tool_end") {
        // mid-turn brake-point — 엔진 round boundary 에 합류 (onGuide).
        flushQueueViaGuide();
        return;
      }
      if (ev.type === "done") {
        // turn 종료 시 큐 잔존 항목 → 새 user message 로 자동 inject.
        // inputOrigin "queue-auto" 사용 — chat.ts validator 가 userActivation
        // 검사 우회 (IPC stream context = user gesture 밖).
        // re-entrancy guard (critic Round 2 M4): inflight inject 중 재 done
        // event 무시 — rapid done sequence 시 cascade race 방지.
        if (queueAutoInflightRef.current) return;
        if (messageQueueStore.size() === 0) return;
        const taken = messageQueueStore.takeAll();
        if (taken.length === 0) return;
        queueAutoInflightRef.current = true;
        const formatted = formatQueueInject(taken);
        void (async () => {
          try {
            await onAsk(formatted, undefined, { injectHint: "queue", inputOrigin: "queue-auto" });
          } finally {
            queueAutoInflightRef.current = false;
          }
        })();
      }
    });
    return unsub;
  }, [api, flushQueueViaGuide, messageQueueStore, onAsk]);

  // streaming false 전이 fallback 폐기 (2026-05-15 사용자 피드백):
  // AskUserQuestion 카드 깜박임 등으로 streaming 이 일시 false → true 로
  // 되돌아갈 때 의도치 않게 큐가 자동 인입되어 사라지는 문제. 자동 인입은
  // tool_end (진정한 brake-point) 에서만. turn 종료 시 큐 잔존 = OK,
  // 사용자가 ESC 또는 esc 취소 로 명시적 inject 트리거.

  // ESC / esc 취소 시 호출 — 큐를 새 user message 로 inject + handleAsk 가
  // 자체 abort 처리 (Issue #622). 큐 비어 있으면 단순 abort 만.
  const flushQueueAsUserMessage = useCallback(() => {
    if (messageQueueStore.size() === 0) {
      void onAbort();
      return;
    }
    const taken = messageQueueStore.takeAll();
    const formatted = formatQueueInject(taken);
    // ESC / esc 취소 = 사용자 명시 인터럽트 → "⚡ 중단후 새메세지" hint.
    void onAsk(formatted, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [messageQueueStore, onAbort, onAsk]);

  // composer Enter morph — busy = queue.add, idle = onAsk 직행.
  // ⌘⏎ = 즉시 주입 (LLM abort + 큐 selected + 현재 입력).
  const handleComposerSend = useCallback(
    (intent: UserKeyboardIntentSnapshot) => {
      const text = question;
      if (text.trim().length === 0 && attachments.length === 0) return;
      if (streaming) {
        // Busy: 큐에 추가. cap 초과 throw catch 해서 textarea 보존.
        if (text.trim().length > 0) {
          try {
            messageQueueStore.add(text);
          } catch (err) {
            console.warn("[message-queue] add rejected:", (err as Error).message);
            return;
          }
        }
        // 첨부도 같이 비움 — busy 분기에서 첨부 잔존하면 다음 idle 입력 시
        // 의도치 않게 따라감 (mental model 위배). 큐 schema 가 첨부 비포함이라
        // busy 시 첨부는 명시적으로 사용자가 재선택하는 것이 명확.
        setQuestion("");
        if (attachments.length > 0) setAttachments([]);
      } else {
        // Idle: 직행 전송
        void onAsk(text, intent);
      }
    },
    [
      question, attachments.length, streaming, messageQueueStore, onAsk,
      setQuestion, setAttachments,
    ],
  );

  const handleImmediateInject = useCallback(() => {
    const text = question.trim();
    const taken = messageQueueStore.takeSelected();
    const parts: string[] = [];
    if (taken.length > 0) parts.push(formatQueueInject(taken));
    if (text.length > 0) parts.push(text);
    if (parts.length === 0) return;
    const combined = parts.join("\n");
    setQuestion("");
    // ⌘⏎ = 사용자 명시 인터럽트 → "⚡ 중단후 새메세지" hint.
    // handleAsk 가 streaming 시 자체 abort 처리.
    void onAsk(combined, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [question, messageQueueStore, onAsk, setQuestion]);

  const handleMessageQueueSendNow = useCallback((item: MessageQueueItem) => {
    messageQueueStore.remove(item.id);
    const text = formatQueueInject([item]);
    void onAsk(text, { inputOrigin: "user-keyboard", token: "" }, { injectHint: "interrupt" });
  }, [messageQueueStore, onAsk]);

  // ESC 우선순위
  //   1. 모달 (Radix Dialog [data-state="open"]) → 모달이 가로챔 (defensive)
  //   2. 큐 선택 항목 있음 → 선택 해제만 (LLM 안 건드림)
  //   3. composer textarea 안에서 ESC → LLM 취소
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      if (messageQueueStore.hasSelected()) {
        e.preventDefault();
        messageQueueStore.clearSelection();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inComposer =
        target?.getAttribute?.("data-testid") === "composer-textarea";
      if (!inComposer) return;
      e.preventDefault();
      // 사용자 의도 (2026-05-15): ESC = LLM abort + 큐를 새 user message 로
      // inject. 멈춤만 하는 게 아니고 큐 항목이 입력으로 보내짐. 빈 큐면
      // 단순 abort. handleAsk 가 자체 abort 처리.
      flushQueueAsUserMessage();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streaming, messageQueueStore, onAbort]);

  // ⌘⏎ — composer textarea 에서 즉시 주입. busy 시 = 인터럽트 (LLM abort + 새
  // turn). idle 시도 동작 (큐가 있으면 큐+입력 inject, 없으면 입력만 send).
  // 사용자 mental model: "⌘⏎ = 지금 즉시 보내" — busy/idle 무관 일관 동작.
  // 가드 (streaming) 제거 — 사용자 보고 2026-05-15 (idle ⌘⏎ 가 무동작이던 회귀).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      // 한국어 IME composing 가드 제거 — composing 시 첫 ⌘⏎ 가 IME commit 으로
      // 소비되고 두 번째 ⌘⏎ 가 동작하는 회귀 (사용자 보고 2026-05-15).
      // 미확정 음절 손실은 마이너 — 사용자 의도 (인터럽트) 가 명확.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      const isComposerTextarea =
        target?.getAttribute?.("data-testid") === "composer-textarea";
      if (!isComposerTextarea) return;
      e.preventDefault();
      handleImmediateInject();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleImmediateInject]);

  // ⌘K = 가이드 호출. text 비어 있으면 noop. busy 와 무관 (idle 에서도 가이드 가능).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      ) {
        return;
      }
      const text = question.trim();
      if (text.length === 0) return;
      e.preventDefault();
      void (async () => {
        const result = await onGuide(text);
        if (result?.ok === true) {
          setQuestion("");
        } else if (result?.ok === false) {
          const message =
            result.error === "queue-full" ? t("chatView.guideErrorQueueFull") :
            result.error === "too-long" ? t("chatView.guideErrorTooLong") :
            result.error === "no-active-turn" ? t("chatView.guideErrorNoActiveTurn") :
            t("chatView.guideErrorFailed", { error: result.error });
          onGuideError(message);
        }
      })();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [question, onGuide, onGuideError, setQuestion]);

  return {
    messageQueueStore,
    handleComposerSend,
    handleMessageQueueSendNow,
    flushQueueAsUserMessage,
  };
}
