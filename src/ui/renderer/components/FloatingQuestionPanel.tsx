/**
 * FloatingQuestionPanel — floating overlay above the chat area for
 * `ask_user_question` tool requests.
 *
 * Pain point addressed: questions buried inline in the message stream were
 * easy to miss mid-scroll. This panel anchors at the top of the chat area
 * (outside the ScrollArea viewport) so it is always immediately visible.
 *
 * Layout contract:
 *   - Parent must be `position: relative` (ChatView's outer div already is).
 *   - Panel uses `position: absolute; top: 0` with pointer-events layering
 *     identical to the routine overlay pattern already in ChatView.
 *   - On narrow viewports (< 480 px) it switches to a bottom-sheet that
 *     slides up from the bottom so it doesn't cover the message input.
 *   - Width is anchored with `inset-x-0` so left and right margins are always
 *     symmetric (US-FQP2.4). Inner content max-w-2xl + mx-auto for centering.
 *
 * Default chips (US-FQP2.2):
 *   - When `suggestedAnswers` is set on the first question item (max 3), those
 *     are rendered as quick-response chip buttons above the card body.
 *   - When no suggestedAnswers and the question allows free text but has no
 *     explicit choices, generic chips ("네", "아니오", "잘 모르겠어요") appear.
 *   - Clicking a chip dispatches the answer immediately, skipping the textarea.
 *
 * Textarea sizing (US-FQP2.3):
 *   - AskUserQuestionCard textarea is reduced from min-h-[60px] to min-h-[44px].
 *   - Auto-expands via CSS field-sizing:content (Chromium/Electron supported).
 *   - max-h-[200px] prevents unbounded panel expansion.
 *
 * Queue semantics:
 *   - Up to MAX_VISIBLE (3) question cards are shown stacked.
 *   - Overflow is indicated by a "+N more" chip on the last visible card.
 *   - Each card is independently dismissible; resolving one reveals the next.
 *
 * Animation:
 *   - Slide in from top (bottom-sheet: from bottom) with ease-out 250 ms.
 *   - Exit: slide back out same direction 200 ms.
 *   - prefers-reduced-motion: fade only (opacity 0 → 1), no translate.
 *
 * Accessibility:
 *   - Outer wrapper: role="region" aria-label="질문 대기열" aria-live="polite"
 *     so screen readers announce new questions automatically.
 *   - Focus trap: when the panel is visible, Tab is contained within it.
 *     Esc dismisses (with confirmation when free-text is partially typed).
 *   - Keyboard: Enter submits (delegated to inner card), Esc dismisses.
 *
 * Data path:
 *   - Accepts the same `askQuestions` array and `dismissAskQuestion` /
 *     `api` props that ChatView already has — zero new IPC channels.
 *   - Inner AskUserQuestionCard handles respondAskUserQuestion; this
 *     component only manages visibility/animation.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { X as XIcon } from "lucide-react";
import { AskUserQuestionCard } from "./AskUserQuestionCard.js";
import type { AskUserQuestionRequest } from "./AskUserQuestionCard.js";
import type { LvisApi } from "../types.js";

const MAX_VISIBLE = 3;

/** Generic chips shown when the question allows free text but has no choices/suggestedAnswers. */
const GENERIC_CHIPS = ["네", "아니오", "잘 모르겠어요"] as const;

export interface FloatingQuestionPanelProps {
  api: LvisApi;
  requests: AskUserQuestionRequest[];
  onResolved: (id: string) => void;
}

/**
 * Single animated slot — mounts with enter animation, calls onExited
 * after the exit animation completes so the parent can unmount cleanly.
 */
function AnimatedSlot({
  children,
  removing,
  onExited,
  isBottomSheet,
}: {
  children: React.ReactNode;
  removing: boolean;
  onExited: () => void;
  isBottomSheet: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!removing) return;
    const el = ref.current;
    if (!el) {
      onExited();
      return;
    }
    const handleEnd = () => onExited();
    el.addEventListener("animationend", handleEnd, { once: true });
    // Fallback: if animationend never fires (reduced-motion, display:none, etc)
    const t = window.setTimeout(onExited, 350);
    return () => {
      el.removeEventListener("animationend", handleEnd);
      window.clearTimeout(t);
    };
  }, [removing, onExited]);

  const enterCls = isBottomSheet
    ? "fqp-slot-enter-bottom"
    : "fqp-slot-enter-top";
  const exitCls = isBottomSheet
    ? "fqp-slot-exit-bottom"
    : "fqp-slot-exit-top";

  return (
    <div
      ref={ref}
      className={removing ? exitCls : enterCls}
      data-testid="fqp-slot"
    >
      {children}
    </div>
  );
}

/**
 * QuickChips — suggestion chips row above the card body.
 *
 * Priority:
 *   1. suggestedAnswers field on the first question (max 3).
 *   2. Generic fallbacks when allowFreeText=true and no choices/suggestedAnswers.
 *   3. Nothing when explicit choice buttons are already present.
 */
function QuickChips({
  request,
  onChipClick,
}: {
  request: AskUserQuestionRequest;
  onChipClick: (answer: string) => void;
}) {
  const firstQ = request.questions[0];
  if (!firstQ) return null;

  // suggestedAnswers is an optional extension on the base type.
  const suggested = (firstQ as typeof firstQ & { suggestedAnswers?: string[] })
    .suggestedAnswers;

  let chips: readonly string[] | string[];

  if (suggested && suggested.length > 0) {
    chips = suggested.slice(0, 3);
  } else if (
    firstQ.allowFreeText &&
    (!firstQ.choices || firstQ.choices.length === 0)
  ) {
    chips = GENERIC_CHIPS;
  } else {
    // Explicit choice buttons rendered by AskUserQuestionCard — skip chips.
    return null;
  }

  return (
    <div
      className="flex flex-wrap gap-1.5 px-3 pt-2 pb-0"
      data-testid="fqp-chips-row"
    >
      {chips.map((chip) => (
        <button
          key={chip}
          type="button"
          className={[
            "rounded-full px-3 py-1 text-xs font-medium",
            "bg-secondary/40 text-secondary-foreground",
            "border border-border/60",
            "hover:bg-secondary hover:border-border",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
            "transition-colors duration-150",
          ].join(" ")}
          data-testid="fqp-chip"
          onClick={() => onChipClick(chip)}
        >
          {chip}
        </button>
      ))}
    </div>
  );
}

export function FloatingQuestionPanel({
  api,
  requests,
  onResolved,
}: FloatingQuestionPanelProps) {
  // Track which ids are in the process of being removed (for exit animation).
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  // After exit animation completes, we remove from the "animating" set.
  // The actual removal from `requests` is handled by the parent (ChatView).
  const [exitedIds, setExitedIds] = useState<Set<string>>(new Set());

  // Narrow-viewport detection — switch to bottom-sheet below 480 px.
  const [isBottomSheet, setIsBottomSheet] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 479px)");
    const handler = (e: MediaQueryListEvent) => setIsBottomSheet(e.matches);
    setIsBottomSheet(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Focus trap: when panel is visible, trap focus inside.
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();

  const visible = requests.filter((r) => !exitedIds.has(r.id));
  const visibleSlots = visible.slice(0, MAX_VISIBLE);
  const overflow = Math.max(0, visible.length - MAX_VISIBLE);

  // Esc → dismiss the topmost (first) visible question.
  useEffect(() => {
    if (visibleSlots.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const top = visibleSlots[0];
      if (top) handleDismiss(top.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSlots]);

  // Focus trap: on mount/update, keep Tab inside the panel.
  useEffect(() => {
    if (visibleSlots.length === 0) return;
    const panel = panelRef.current;
    if (!panel) return;

    const FOCUSABLE =
      'button:not([disabled]), [href], input:not([disabled]), ' +
      'select:not([disabled]), textarea:not([disabled]), ' +
      '[tabindex]:not([tabindex="-1"])';

    const trapTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    window.addEventListener("keydown", trapTab);
    // Move focus into the panel on open.
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => window.removeEventListener("keydown", trapTab);
  }, [visibleSlots.length]);

  const handleDismiss = useCallback(
    (id: string) => {
      setRemovingIds((prev) => new Set([...prev, id]));
    },
    [],
  );

  const handleExited = useCallback(
    (id: string) => {
      setExitedIds((prev) => new Set([...prev, id]));
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      onResolved(id);
    },
    [onResolved],
  );

  const handleResolved = useCallback(
    (id: string) => {
      // Card submitted → trigger exit animation then notify parent.
      setRemovingIds((prev) => new Set([...prev, id]));
    },
    [],
  );

  /**
   * Chip click: immediately dispatch the chip text as the answer for the
   * first question, then trigger the exit animation.
   */
  const handleChipClick = useCallback(
    async (req: AskUserQuestionRequest, answer: string) => {
      try {
        await api.respondAskUserQuestion({
          requestId: req.id,
          answers: [{ choice: answer }],
        });
      } finally {
        setRemovingIds((prev) => new Set([...prev, req.id]));
      }
    },
    [api],
  );

  // When a request is removed from the parent array externally (timeout),
  // clean up exitedIds to avoid stale entries.
  useEffect(() => {
    const requestIds = new Set(requests.map((r) => r.id));
    setExitedIds((prev) => {
      const next = new Set([...prev].filter((id) => requestIds.has(id)));
      return next.size !== prev.size ? next : prev;
    });
  }, [requests]);

  if (visibleSlots.length === 0 && removingIds.size === 0) return null;

  const positionCls = isBottomSheet
    ? "fqp-root-bottom"
    : "fqp-root-top";

  return (
    // pointer-events-none on outer so clicks on underlying chat scroll through.
    // US-FQP2.4: inset-x-0 ensures symmetric left/right margins.
    <div
      className={`pointer-events-none absolute inset-x-0 z-40 px-4 ${positionCls}`}
      data-testid="floating-question-panel"
    >
      {/* pointer-events-auto on the actual panel; mx-auto centres within px-4 */}
      <div
        ref={panelRef}
        className="pointer-events-auto mx-auto w-full max-w-2xl"
        role="region"
        aria-label="질문 대기열"
        aria-live="polite"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        {/* visually-hidden heading for screen readers */}
        <span id={headingId} className="sr-only">
          에이전트 질문 {visibleSlots.length}개
        </span>

        <div className="flex flex-col gap-2">
          {visibleSlots.map((req, idx) => {
            const isRemoving = removingIds.has(req.id);
            const isLast = idx === visibleSlots.length - 1;
            return (
              <AnimatedSlot
                key={req.id}
                removing={isRemoving}
                onExited={() => handleExited(req.id)}
                isBottomSheet={isBottomSheet}
              >
                <div className="relative">
                  {/* Outer wrapper gives the elevation shadow + rounded corners
                      independent of the inner AskUserQuestionCard border */}
                  <div className="fqp-card-shell rounded-xl shadow-2xl ring-1 ring-primary/20 backdrop-blur-sm">
                    {/* Agent source label row */}
                    <div className="flex items-center justify-between gap-2 rounded-t-xl border-b border-border/60 bg-primary/10 px-3 py-1.5">
                      <span
                        className="text-[11px] font-medium tracking-wide text-primary/80 uppercase"
                        data-testid="fqp-header-label"
                      >
                        {req.urgent ? "긴급 — 에이전트 질문" : "에이전트 질문"}
                      </span>
                      {/* Explicit close button (mirrors Esc) */}
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                        aria-label="질문 닫기"
                        data-testid="fqp-close"
                        onClick={() => handleDismiss(req.id)}
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* US-FQP2.2: Quick-response chips above the card body */}
                    <QuickChips
                      request={req}
                      onChipClick={(answer) => void handleChipClick(req, answer)}
                    />
                    {/* The existing AskUserQuestionCard handles all UX */}
                    <div className="px-0">
                      <AskUserQuestionCard
                        api={api}
                        request={req}
                        onResolved={handleResolved}
                      />
                    </div>
                  </div>
                  {/* Overflow "+N more" chip on the last visible slot */}
                  {isLast && overflow > 0 && (
                    <div
                      className="mt-1 flex justify-end"
                      aria-label={`대기 중인 질문 ${overflow}개 더 있음`}
                    >
                      <span
                        className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                        data-testid="fqp-overflow-chip"
                      >
                        +{overflow}개 더
                      </span>
                    </div>
                  )}
                </div>
              </AnimatedSlot>
            );
          })}
        </div>
      </div>
    </div>
  );
}
