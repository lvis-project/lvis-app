import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  MessageQueueStore,
  formatQueueInject,
  type MessageQueueItem,
} from "../state/message-queue-store.js";
import type { Attachment } from "../types/attachments.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { StreamEvent } from "../../../lib/chat-stream-state.js";
import type { ComposerHandle, ComposerSurface } from "../components/Composer.js";

/**
 * Mid-turn guidance: the brake-point hand-off (`tool_end` → engine round
 * boundary) and the ⌘K shortcut. Only a loop that exposes a guide channel can
 * offer it; a surface without one drains its queue at the end of the turn
 * instead, and the shortcut is not registered.
 */
interface MessageQueueGuide {
  inject: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onError: (message: string) => void;
}

/**
 * Where the dev/e2e seam publishes each surface's live store. One key per
 * surface: the side chat mounting must not shadow the main store a Playwright
 * spec is asserting against.
 */
const DEV_STORE_KEY: Record<ComposerSurface, "__lvis_message_queue_store__" | "__lvis_side_chat_message_queue_store__"> = {
  main: "__lvis_message_queue_store__",
  side: "__lvis_side_chat_message_queue_store__",
};

export interface UseMessageQueueParams {
  /** Which composer this queue belongs to — selects the dev/e2e store seam. */
  surface: ComposerSurface;
  /**
   * The stream this queue drains against: the group's `onChatStream` for a
   * main tile, `sideChat.onStream` for the side chat. The two are isolated by
   * wire channel, so a queue subscribed to the wrong one would drain on the
   * other surface's `done`.
   */
  subscribeStream: (handler: (event: StreamEvent) => void) => () => void;
  /**
   * Does this frame belong to the turn currently on screen? A surface whose
   * stream carries a turn id (side chat's monotonic `streamId`) supplies its
   * OWN verdict here so this queue and that surface's transcript agree.
   *
   * Without it, an aborted turn's trailing `done` — `runStreamedTurn` emits
   * `turn.completed` on every return, abort included — drains a queued row
   * into a `queue-auto` send. That send skips the interrupt (a drain must not
   * stop the turn that follows it), so it lands on top of the turn the user's
   * interrupt just started: two turns on one ConversationLoop.
   *
   * Omitted by a surface whose host serializes turns for itself and whose
   * frames carry no turn id to judge by; every frame then counts as current.
   */
  isCurrentTurnEvent?: (event: StreamEvent) => boolean;
  /**
   * The composer whose textarea the window-level shortcuts (⌘⏎, Esc) act on.
   * Several composers are mounted at once — one per tile, plus the side chat
   * — and every one of them carries the same test id, so ownership is decided
   * by element identity, not by attribute.
   */
  composerRef: RefObject<ComposerHandle | null>;
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
  guide?: MessageQueueGuide;
  onAbort: () => void | Promise<void>;
  /**
   * First refusal on composer submissions. Returns true when it has consumed
   * the text, in which case the composer clears and nothing is queued or sent.
   * `/allow` uses it to answer a pending approval instead of talking to the
   * model — see {@link ./use-approval-sentence.js}. Both submit gestures route
   * through it, so ⌘⏎ cannot slip past what Enter honours.
   */
  interceptSubmit?: (text: string) => boolean;
}

export interface UseMessageQueueResult {
  messageQueueStore: MessageQueueStore;
  handleComposerSend: (intent: UserKeyboardIntentSnapshot) => void;
  handleMessageQueueSendNow: (item: MessageQueueItem) => void;
  flushQueueAsUserMessage: () => void;
}

/**
 * Owns the mid-turn message queue: the per-view store (+ dev/e2e window hook +
 * session-change clear), the stream brake-point drains (tool_end → guide,
 * done → queue-auto onAsk with re-entrancy guard), and the composer/streaming
 * keyboard flows (Enter morph, ESC inject-or-abort, ⌘⏎ immediate inject, ⌘K
 * guide). One hook serves every composer surface — a main tile and the side
 * chat differ only in the stream they drain against and whether the loop
 * behind them exposes a guide channel.
 */
export function useMessageQueue({
  surface,
  subscribeStream,
  composerRef,
  currentSessionId,
  question,
  attachments,
  streaming,
  setQuestion,
  setAttachments,
  onAsk,
  guide,
  onAbort,
  interceptSubmit,
  isCurrentTurnEvent,
}: UseMessageQueueParams): UseMessageQueueResult {
  const { t } = useTranslation();


  const messageQueueStore = useMemo(() => new MessageQueueStore(), []);

  const queueAutoInflightRef = useRef(false);
  /** A guide hand-off is awaiting its result — do not send the same items again. */
  const guideFlushInflightRef = useRef(false);
  /** The engine refused this turn's hand-off — stop retrying until the turn ends. */
  const guideFlushBlockedRef = useRef(false);

  // dev/e2e runtime test hook — Playwright launches production-built renderer
  // assets, so this must use preload runtime env instead of build-time NODE_ENV.
  useEffect(() => {
    const key = DEV_STORE_KEY[surface];
    const w = window as unknown as Partial<Record<typeof key, MessageQueueStore>> & {
      lvis?: { env?: { isDev?: boolean; isE2E?: boolean } };
    };
    if (w.lvis?.env?.isDev === true && w.lvis?.env?.isE2E === true) {
      w[key] = messageQueueStore;
    }
    return () => {
      if (w[key] === messageQueueStore) {
        delete w[key];
      }
    };
  }, [messageQueueStore, surface]);

  /** True when the keyboard event was raised inside THIS composer's textarea. */
  const ownsTarget = useCallback(
    (target: EventTarget | null): boolean => {
      const textarea = composerRef.current?.textarea();
      return textarea !== null && textarea !== undefined && target === textarea;
    },
    [composerRef],
  );
  useEffect(() => {
    messageQueueStore.clear();
    // The guide-flush refs are turn-scoped, and `done` is what normally clears
    // them. Switching sessions mid-turn means that `done` never arrives for
    // this hook, so a refusal from the old session would keep suppressing
    // brake-point hand-offs in the new one. Reset them with the queue.
    guideFlushInflightRef.current = false;
    guideFlushBlockedRef.current = false;
  }, [currentSessionId, messageQueueStore]);



  //


  //


  /**
   * Hand the queue to the engine at a mid-turn brake point.
   *
   * The removal is CONFIRMED, not optimistic: the items stay in the store —
   * and therefore on screen — until `onGuide` says the engine accepted them.
   * The previous shape took them synchronously and fired `onGuide` off
   * unawaited, so the panel emptied on the first `tool_end` of the turn and a
   * refusal (`no-active-turn` when the brake point lands in the turn's
   * `finally` window) destroyed text the user had typed.
   *
   * Two guards make "keep on failure" safe:
   *   - `guideFlushInflightRef` — a burst of `tool_end` events cannot send the
   *     same items twice now that they survive the first attempt.
   *   - `guideFlushBlockedRef` — after a refusal, stop retrying for the rest
   *     of the turn (one toast, not one per tool). The items stay queued and
   *     the `done` handler injects them as a fresh turn, so nothing is lost.
   */
  const flushQueueViaGuide = useCallback(() => {
    if (!guide) return;
    if (guideFlushInflightRef.current || guideFlushBlockedRef.current) return;
    const pending = messageQueueStore.getPending();
    if (pending.length === 0) return;
    const handed = pending.map((item) => ({ id: item.id, text: item.text }));
    const count = pending.length;
    const formatted = formatQueueInject(pending);
    guideFlushInflightRef.current = true;
    void (async () => {
      try {
        const result = await guide.inject(formatted);
        if (result?.ok === true) {
          // Match by id AND text. Rows stay editable while the call is in
          // flight, so an id alone would mark a row the user rewrote after the
          // engine had already seen the old wording. A rewritten row stays
          // pending and goes out at the next brake point, as does anything
          // queued during the call.
          //
          // MARK, not remove: the engine has accepted this text but will not
          // deliver it until its next round boundary. The row stays on screen
          // as handed-off until `guidance_injected` reports it delivered.
          const current = new Map(
            messageQueueStore.getItems().map((item) => [item.id, item.text]),
          );
          messageQueueStore.markHandedOff(
            handed.filter(({ id, text }) => current.get(id) === text).map(({ id }) => id),
            formatted,
          );
          return;
        }
        const reason = result?.error ?? "unknown";
        const reasonLabel =
          reason === "queue-full" ? t("chatView.queueFlushFailReasonFull") :
          reason === "too-long" ? t("chatView.queueFlushFailReasonTooLong") :
          reason === "no-active-turn" ? t("chatView.queueFlushFailReasonNoTurn") :
          `(${reason})`;
        guideFlushBlockedRef.current = true;
        guide.onError(t("chatView.queueFlushFailMessage", { count, reasonLabel }));
        console.warn(`[message-queue] guide flush refused (${reason}), items kept:`, formatted.slice(0, 80));
      } finally {
        guideFlushInflightRef.current = false;
      }
    })();
  }, [messageQueueStore, guide, t]);

  useEffect(() => {
    const unsub = subscribeStream((ev) => {
      // A frame from a superseded turn drives nothing here: not the
      // brake-point hand-off, not the delivery bookkeeping, and above all not
      // the end-of-turn drain.
      if (isCurrentTurnEvent && !isCurrentTurnEvent(ev)) return;
      if (ev.type === "tool_end") {
        // mid-turn brake-point — 엔진 round boundary 에 합류 (onGuide).
        flushQueueViaGuide();
        return;
      }
      if (ev.type === "guidance_injected") {
        // Delivered. The text is a user bubble in the transcript now, so the
        // row has somewhere to have gone — this is the only place it is
        // cleared after a hand-off.
        const text = typeof ev.text === "string" ? ev.text : "";
        if (text.length > 0) messageQueueStore.clearDelivered(text);
        return;
      }
      if (ev.type === "guidance_dropped") {
        // The engine took it but could not deliver it. The rows are the
        // user's again so the end-of-turn drain below picks them up — the
        // `done` that follows this event does exactly that.
        messageQueueStore.releaseHandedOff();
        return;
      }
      if (ev.type === "error") {
        // A turn that ends in an error has still ended, and `done` does not
        // always follow. Release the block here too, or one refused hand-off
        // would keep suppressing brake points for every turn after it.
        guideFlushBlockedRef.current = false;
        return;
      }
      if (ev.type === "done") {
        // A refusal only blocks the rest of THAT turn; the next one starts
        // clean and may use its brake points again.
        guideFlushBlockedRef.current = false;
        // turn 종료 시 큐 잔존 항목 → 새 user message 로 자동 inject.
        // inputOrigin "queue-auto" 사용 — chat.ts validator 가 userActivation
        // 검사 우회 (IPC stream context = user gesture 밖).
        // re-entrancy guard (critic Round 2 M4): inflight inject 중 재 done
        // event 무시 — rapid done sequence 시 cascade race 방지.
        if (queueAutoInflightRef.current) return;
        // Handed-off rows are already with the engine — re-sending them here
        // would duplicate the message. A hand-off the engine could not deliver
        // has been released by `guidance_dropped` above, so it is pending again
        // and included.
        const taken = [...messageQueueStore.getPending()];
        if (taken.length === 0) return;
        for (const item of taken) messageQueueStore.remove(item.id);
        queueAutoInflightRef.current = true;
        const formatted = formatQueueInject(taken);
        // Deferred OUT of this dispatch. The send that follows re-arms the
        // surface's stale-frame guard synchronously, and a subscriber that has
        // not judged this frame yet would then read it as belonging to a
        // superseded turn — the transcript would drop its own `done` and leave
        // the answer stuck mid-stream. A microtask runs after every subscriber
        // on the channel has been called and long before the user can act, so
        // the drain no longer depends on this hook subscribing last.
        //
        // The rows are removed and the re-entrancy flag is set ABOVE, still
        // inside the dispatch: a second `done` arriving before the microtask
        // runs must find the queue already taken.
        queueMicrotask(() => {
          void (async () => {
            try {
              await onAsk(formatted, undefined, { injectHint: "queue", inputOrigin: "queue-auto" });
            } finally {
              queueAutoInflightRef.current = false;
            }
          })();
        });
      }
    });
    return unsub;
  }, [subscribeStream, flushQueueViaGuide, messageQueueStore, onAsk, isCurrentTurnEvent]);

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
      if (interceptSubmit?.(text)) {
        setQuestion("");
        return;
      }
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
      setQuestion, setAttachments, interceptSubmit,
    ],
  );

  const handleImmediateInject = useCallback(() => {
    const text = question.trim();
    if (interceptSubmit?.(text)) {
      setQuestion("");
      return;
    }
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
  }, [question, messageQueueStore, onAsk, setQuestion, interceptSubmit]);

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
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-testid="approval-dock"]',
        )
      ) {
        return;
      }
      if (messageQueueStore.hasSelected()) {
        e.preventDefault();
        messageQueueStore.clearSelection();
        return;
      }
      if (!ownsTarget(e.target)) return;
      e.preventDefault();
      // ESC = LLM abort + the queue injected as a new user message — not a
      // bare stop. An empty queue is a plain abort; onAsk aborts for itself.
      flushQueueAsUserMessage();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [streaming, messageQueueStore, ownsTarget, flushQueueAsUserMessage]);

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
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-testid="approval-dock"]',
        )
      ) {
        return;
      }
      if (!ownsTarget(e.target)) return;
      e.preventDefault();
      handleImmediateInject();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleImmediateInject, ownsTarget]);

  // ⌘K = 가이드 호출. text 비어 있으면 noop. busy 와 무관 (idle 에서도 가이드 가능).
  useEffect(() => {
    if (!guide) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "k" && e.key !== "K") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.isComposing) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-testid="approval-dock"]',
        )
      ) {
        return;
      }
      const text = question.trim();
      if (text.length === 0) return;
      e.preventDefault();
      void (async () => {
        const result = await guide.inject(text);
        if (result?.ok === true) {
          setQuestion("");
        } else if (result?.ok === false) {
          const message =
            result.error === "queue-full" ? t("chatView.guideErrorQueueFull") :
            result.error === "too-long" ? t("chatView.guideErrorTooLong") :
            result.error === "no-active-turn" ? t("chatView.guideErrorNoActiveTurn") :
            t("chatView.guideErrorFailed", { error: result.error });
          guide.onError(message);
        }
      })();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [question, guide, setQuestion, t]);

  return {
    messageQueueStore,
    handleComposerSend,
    handleMessageQueueSendNow,
    flushQueueAsUserMessage,
  };
}
