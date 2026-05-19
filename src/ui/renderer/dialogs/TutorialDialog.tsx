/**
 * Tutorial-D — Discovery Swipe dialog.
 *
 * Mockup SoT: `/tmp/login-lvis/index.html` § O-X3 Discovery Swipe.
 *
 * Behavior:
 *   - Renders a stack of 5 scenario cards (background → middle → top).
 *   - Top card gets a violet ring + glow; the two background cards are
 *     rotated and translated to suggest a deck.
 *   - Controls:
 *       ✕  (destructive) → record `disliked` + advance
 *       ↺  (muted)       → undo the last action (restores the prior card)
 *       ✓  (success)     → record `liked` + advance
 *   - Keyboard:
 *       ↑ / ArrowUp  → ✓
 *       ↓ / ArrowDown → ✕
 *       Space        → skipped (advance without like/dislike)
 *       z            → ↺ (undo)
 *   - When the deck is exhausted the dialog shows a "추천 완료" summary
 *     listing the user's chosen scenarios and invokes
 *     `api.tutorialTourStart(scenarioId)` on the first preferred card
 *     (or the fallback baseline if none were liked).
 *
 * LVIS tokens: card surface follows the mockup's `hsl(222 47% 13%)` tone
 * which maps to the `bg-card` semantic + a `border-action-view/30` accent.
 * Violet ring uses `--p-purple-500` so the LVIS palette stays in charge.
 */
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { cn } from "../../../lib/utils.js";
import {
  DISCOVERY_CARDS,
  FALLBACK_SCENARIO_ID,
  resolveScenarioId,
  type DiscoveryCard,
} from "../onboarding/discovery-cards.js";
import type { TutorialAction } from "../types.js";

/**
 * F5 — `prefers-reduced-motion` reactive hook. When the OS toggle is set
 * to "reduce" we swap the rotate+translate deck transforms for opacity-only
 * positioning so a vestibular-sensitive user does not see the cards rotate.
 */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = React.useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(mq.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return reduce;
}

export interface TutorialDialogApi {
  tutorialRecord: (
    payload: { cardId: string; action: TutorialAction },
  ) => Promise<{ ok: boolean }>;
  /**
   * Tutorial-C `tour.start` bridge — the Discovery Swipe dialog dispatches
   * the user's preferred scenario through the Spotlight engine entry
   * point so there is exactly one place that owns the tour contract.
   */
  tour: {
    start: (scenarioId: string) => Promise<{ ok: boolean }>;
  };
  /**
   * Tutorial-X2 — real plugin install bridge. When a Discovery Swipe card
   * has a non-null `pluginId` and the user marks it `liked`, the dialog
   * fires this method so the host installs the plugin via the canonical
   * marketplace install pipeline. Omitting the method (older callers /
   * tests) makes the install step a no-op — the user's `liked` action is
   * still recorded so the tour still launches at the end of the deck.
   */
  tutorialInstallPlugin?: (pluginId: string) => Promise<
    | { ok: true; pluginId: string }
    | { ok: false; error: string; message: string }
  >;
}

export interface TutorialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: TutorialDialogApi;
  /** Override card deck for tests/storybook; defaults to DISCOVERY_CARDS. */
  cards?: readonly DiscoveryCard[];
}

interface HistoryEntry {
  cardIndex: number;
  action: TutorialAction;
}

export function TutorialDialog({
  open,
  onOpenChange,
  api,
  cards = DISCOVERY_CARDS,
}: TutorialDialogProps) {
  const [cursor, setCursor] = React.useState(0);
  const [history, setHistory] = React.useState<HistoryEntry[]>([]);
  const [submitted, setSubmitted] = React.useState(false);

  // Reset deck state every time the dialog opens so a re-entry starts
  // from card 0. Closing the dialog mid-deck preserves nothing — the
  // user's persisted likes/dislikes already live in `~/.lvis/tutorial/`.
  React.useEffect(() => {
    if (open) {
      setCursor(0);
      setHistory([]);
      setSubmitted(false);
    }
  }, [open]);

  const total = cards.length;
  const finished = cursor >= total;
  const currentCard = !finished ? cards[cursor] : undefined;

  // Apply a single action: persist via IPC + (when the card has a
  // pluginId) fire-and-forget a real install via `tutorialInstallPlugin`.
  // Install failures never block the deck because the user is mid-swipe;
  // any failure is surfaced through the host's existing install audit /
  // notification path (the same one the marketplace UI relies on).
  const recordAction = React.useCallback(
    (action: TutorialAction) => {
      if (finished) return;
      const card = cards[cursor];
      if (!card) return;
      if (action !== "skipped") {
        void api.tutorialRecord({ cardId: card.id, action }).catch(() => {
          /* Persistence failure is logged main-side; UI keeps flowing
             so the user is never blocked on a disk hiccup. */
        });
      }
      // Tutorial-X2 — real plugin install on `liked` + non-null pluginId.
      // The bridge is optional so older callers / tests still work.
      if (
        action === "liked" &&
        card.pluginId &&
        typeof api.tutorialInstallPlugin === "function"
      ) {
        void api.tutorialInstallPlugin(card.pluginId).catch(() => {
          /* install path emits its own audit + lifecycle broadcasts —
             the dialog never needs to surface a toast itself */
        });
      }
      setHistory((prev) => [...prev, { cardIndex: cursor, action }]);
      setCursor((prev) => prev + 1);
    },
    [api, cards, cursor, finished],
  );

  const undoAction = React.useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      const card = cards[last.cardIndex];
      if (card && (last.action === "liked" || last.action === "disliked")) {
        void api.tutorialRecord({ cardId: card.id, action: "undone" }).catch(() => {
          /* see recordAction comment */
        });
      }
      setCursor(last.cardIndex);
      return prev.slice(0, -1);
    });
  }, [api, cards]);

  // Keyboard shortcuts: bound only while the dialog is mounted + open
  // + on a card (the "추천 완료" summary handles its own button focus).
  React.useEffect(() => {
    if (!open || finished) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        recordAction("liked");
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        recordAction("disliked");
      } else if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        recordAction("skipped");
      } else if (event.key === "z" || event.key === "Z") {
        event.preventDefault();
        undoAction();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finished, recordAction, undoAction]);

  // U2 — Dispatch the chosen scenario ONLY when the user explicitly
  // clicks "가이드 시작" on the FinishedSummary screen. Auto-firing the
  // tour while the Dialog was still mounted caused the SpotlightTour to
  // paint backdrop+ring behind the Radix Dialog portal — the user saw
  // a purple ring floating in empty space (the composer was hidden
  // behind the modal).
  //
  // We pre-compute `chosenScenarioId` so the test (and the click
  // handler) read a deterministic value from history.
  const chosenScenarioId = React.useMemo(() => {
    const likedIds = new Set(
      history.filter((h) => h.action === "liked").map((h) => h.cardIndex),
    );
    const preferred = cards.find((_, idx) => likedIds.has(idx));
    return preferred ? resolveScenarioId(preferred) : FALLBACK_SCENARIO_ID;
  }, [cards, history]);

  // Sequential close-then-start: close the Dialog first, then dispatch
  // tour.start after a short delay so Radix has time to unmount the
  // portal. Without this, SpotlightTour mounts while DialogContent is
  // still in the DOM and `getBoundingClientRect` of the anchor returns
  // a rect occluded by the modal.
  const handleStartTour = React.useCallback(
    (scenarioId: string) => {
      if (submitted) return;
      setSubmitted(true);
      onOpenChange(false);
      // 80ms is enough for Radix's exit animation + portal unmount in
      // both reduced-motion and full-motion modes. Verified manually
      // against the 200ms Radix default animation duration.
      window.setTimeout(() => {
        void api.tour.start(scenarioId).catch(() => {
          /* renderer keeps the chat surface visible even if the
             dispatch fails — there's no useful recovery action. */
        });
      }, 80);
    },
    [api, onOpenChange, submitted],
  );

  // U7 — "실행하기" CTA on each active deck card: lets the user run a
  // scenario directly without finishing the swipe deck. Persists the
  // implicit "liked" preference for the chosen card and then drives the
  // same close-then-start transition as the FinishedSummary CTA.
  const handleRunCurrent = React.useCallback(() => {
    if (finished || submitted) return;
    const card = cards[cursor];
    if (!card) return;
    void api.tutorialRecord({ cardId: card.id, action: "liked" }).catch(() => {
      /* see recordAction comment */
    });
    handleStartTour(resolveScenarioId(card));
  }, [api, cards, cursor, finished, submitted, handleStartTour]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        className="flex max-h-[840px] min-w-0 flex-col gap-0 overflow-hidden p-0"
        data-testid="tutorial-dialog"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>관심 있는 시나리오를 선택하세요</DialogTitle>
          <DialogDescription>
            LVIS 의 5가지 시나리오 카드를 좌/우로 swipe 해서 선호도를 알려주세요.
          </DialogDescription>
        </DialogHeader>

        {!finished && currentCard ? (
          <ActiveDeck
            card={currentCard}
            cards={cards}
            cursor={cursor}
            onLike={() => recordAction("liked")}
            onDislike={() => recordAction("disliked")}
            onUndo={undoAction}
            canUndo={history.length > 0}
            onRun={handleRunCurrent}
          />
        ) : (
          <FinishedSummary
            cards={cards}
            history={history}
            onStart={() => handleStartTour(chosenScenarioId)}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ActiveDeckProps {
  card: DiscoveryCard;
  cards: readonly DiscoveryCard[];
  cursor: number;
  onLike: () => void;
  onDislike: () => void;
  onUndo: () => void;
  canUndo: boolean;
  /** U7 — "실행하기" CTA on the visible top card. */
  onRun: () => void;
}

function ActiveDeck({
  card,
  cards,
  cursor,
  onLike,
  onDislike,
  onUndo,
  canUndo,
  onRun,
}: ActiveDeckProps) {
  const total = cards.length;
  const reduceMotion = usePrefersReducedMotion();

  // U9 — Swipe animation state. `exitDirection` drives the swipe-out
  // transform on the top card when the user commits to a like / dislike;
  // we delay the actual cursor advance (via `onLike` / `onDislike`) until
  // the exit animation completes so the visual feedback is preserved.
  // `dragOffset` tracks live drag-by-pointer translation so the card
  // follows the cursor and reveals a ✓ / ✕ stamp.
  type ExitDirection = "left" | "right" | null;
  const [exitDirection, setExitDirection] = React.useState<ExitDirection>(null);
  const [dragOffset, setDragOffset] = React.useState({ x: 0, y: 0 });
  const dragStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  // Reset transient swipe state when the card id changes — fresh deck
  // entry should never inherit the prior card's drag offset.
  React.useEffect(() => {
    setExitDirection(null);
    setDragOffset({ x: 0, y: 0 });
    dragStartRef.current = null;
  }, [card.id]);

  const SWIPE_THRESHOLD = 100;
  // Under reduced motion the swipe-out animation collapses to a fast
  // opacity fade — vestibular users still see *something* happen, but
  // without the translate/rotate that they would experience as motion.
  const EXIT_DURATION_MS = reduceMotion ? 150 : 300;

  const commit = React.useCallback(
    (direction: "left" | "right") => {
      if (exitDirection) return;
      setExitDirection(direction);
      window.setTimeout(() => {
        if (direction === "right") {
          onLike();
        } else {
          onDislike();
        }
      }, EXIT_DURATION_MS);
    },
    [exitDirection, onLike, onDislike, EXIT_DURATION_MS],
  );

  // ─── Pointer-drag handlers ──────────────────────────────────────
  // We bind pointermove/up on `window` once drag starts so the user can
  // continue dragging even if the cursor leaves the card bounds. This
  // matches Tinder/Hinge ergonomics — once you commit to a swipe, you
  // shouldn't have to keep the cursor pinned to the card.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (exitDirection) return;
    if (e.button !== 0) return;
    // Don't hijack drag on the "실행하기" / nested buttons — they have
    // their own click semantics.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "BUTTON") return;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current || exitDirection) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setDragOffset({ x: dx, y: dy });
  };
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    dragStartRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (dx > SWIPE_THRESHOLD) {
      commit("right");
      return;
    }
    if (dx < -SWIPE_THRESHOLD) {
      commit("left");
      return;
    }
    // Spring-back — let the CSS transition animate the card back to
    // centre via the `transition` style applied below when not dragging.
    setDragOffset({ x: 0, y: 0 });
  };

  // ─── Compute live transform for the top card ────────────────────
  let topCardStyle: React.CSSProperties = {};
  let stampOpacity = 0;
  let stampSide: "left" | "right" | null = null;
  if (exitDirection) {
    // Exit animation — fully off-screen + rotate + fade.
    if (reduceMotion) {
      topCardStyle = {
        opacity: 0,
        transition: `opacity ${EXIT_DURATION_MS}ms ease-out`,
      };
    } else {
      const sign = exitDirection === "right" ? 1 : -1;
      topCardStyle = {
        transform: `translate(${sign * 120}%, -10%) rotate(${sign * 15}deg)`,
        opacity: 0,
        transition: `transform ${EXIT_DURATION_MS}ms ease-out, opacity ${EXIT_DURATION_MS}ms ease-out`,
      };
    }
    stampOpacity = 1;
    stampSide = exitDirection;
  } else if (dragOffset.x !== 0 || dragOffset.y !== 0) {
    // Drag follow — translate + rotate proportional to drag-X.
    if (reduceMotion) {
      topCardStyle = {
        opacity: Math.max(0.5, 1 - Math.abs(dragOffset.x) / 600),
      };
    } else {
      const rot = dragOffset.x / 18; // ~16deg max at 280px drag
      topCardStyle = {
        transform: `translate(${dragOffset.x}px, ${dragOffset.y * 0.3}px) rotate(${rot}deg)`,
        transition: "none",
      };
    }
    if (Math.abs(dragOffset.x) > 16) {
      stampOpacity = Math.min(1, Math.abs(dragOffset.x) / SWIPE_THRESHOLD);
      stampSide = dragOffset.x > 0 ? "right" : "left";
    }
  } else {
    // Idle — apply spring-back transition when offset resets to zero so
    // the card glides home after a non-committed drag.
    topCardStyle = reduceMotion
      ? {}
      : { transition: "transform 200ms ease-out" };
  }

  // F5 — under reduced-motion, the decorative back/middle cards drop
  // their `rotate(...)` transform and shift to opacity-only fades so a
  // vestibular-sensitive user does not see the cards rotate. The
  // mockup-faithful tilt only applies when motion is allowed.
  const backCardStyle: React.CSSProperties = reduceMotion
    ? { opacity: 0.5, top: "18%" }
    : { transform: "rotate(-3deg) translate(-12px, 12px)", top: "18%" };
  const middleCardStyle: React.CSSProperties = reduceMotion
    ? { opacity: 0.75, top: "16%" }
    : { transform: "rotate(2deg) translate(8px, 6px)", top: "16%" };

  const handleLikeClick = () => commit("right");
  const handleDislikeClick = () => commit("left");

  return (
    <div
      className="flex h-[640px] min-w-0 flex-col"
      data-testid="tutorial-dialog:active"
      data-reduce-motion={reduceMotion ? "true" : "false"}
    >
      <div className="px-4 pt-4 pb-2">
        <div
          className="text-[10px] uppercase tracking-wider text-muted-foreground"
          data-testid="tutorial-dialog:progress"
        >
          {cursor + 1} / {total}
        </div>
        <h2 className="mt-0.5 text-[15px] font-semibold">
          관심 있는 시나리오를 선택하세요
        </h2>
        <p className="mt-0.5 text-[10.5px] text-muted-foreground">
          드래그 또는 ⬆⬇ · ⎵ 건너뛰기 · z 되돌리기 · "실행하기" 로 즉시 가이드
        </p>
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center px-6 py-4">
        {/* back card (decorative) */}
        <div
          aria-hidden
          className="absolute h-[58%] w-[80%] rounded-2xl border border-border bg-card/80"
          style={backCardStyle}
        />
        {/* middle card (decorative) */}
        <div
          aria-hidden
          className="absolute h-[60%] w-[85%] rounded-2xl border border-border bg-card"
          style={middleCardStyle}
        />
        {/* top card — drag-interactive */}
        <div
          ref={cardRef}
          data-testid="tutorial-dialog:top-card"
          data-card-id={card.id}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{ ...topCardStyle, touchAction: "none", cursor: "grab" }}
          className={cn(
            "relative w-[90%] overflow-hidden rounded-2xl border bg-card select-none",
            "border-[hsl(var(--p-purple-500)/0.5)]",
            "shadow-[0_20px_50px_-10px_hsl(var(--p-purple-500)/0.3)]",
            "ring-1 ring-[hsl(var(--p-purple-500)/0.6)]",
          )}
        >
          {/* U9 — ✓ / ✕ stamp overlay that fades in during drag and is
              fully visible at the moment of commit. The stamp is purely
              decorative; it never accepts pointer events. */}
          {stampSide ? (
            <div
              aria-hidden
              data-testid="tutorial-dialog:stamp"
              data-stamp-side={stampSide}
              style={{
                position: "absolute",
                top: 18,
                ...(stampSide === "right" ? { right: 18 } : { left: 18 }),
                opacity: stampOpacity,
                transform: `rotate(${stampSide === "right" ? -15 : 15}deg)`,
                padding: "4px 12px",
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "0.1em",
                border: `3px solid ${stampSide === "right" ? "hsl(var(--success))" : "hsl(var(--destructive))"}`,
                color: stampSide === "right" ? "hsl(var(--success))" : "hsl(var(--destructive))",
                borderRadius: 6,
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              {stampSide === "right" ? "LIKE" : "NOPE"}
            </div>
          ) : null}
          <div
            className="flex h-28 items-center justify-center text-5xl"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
            }}
            aria-hidden
          >
            {card.icon}
          </div>
          <div className="space-y-1.5 p-4">
            <div
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "hsl(var(--p-purple-500) / 0.75)" }}
            >
              SCENARIO {cursor + 1} of {total}
            </div>
            <div
              className="text-[14px] font-semibold leading-tight"
              data-testid="tutorial-dialog:card-title"
            >
              {card.title}
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
              {card.description}
            </p>
            <div className="mt-2 flex flex-wrap gap-1 text-[9.5px]">
              {card.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
            {/* U7 — Preview steps mini-list. Shows the user *what* the
                spotlight tour will demonstrate before they commit to
                running it. Each step is numbered so the visual mirrors
                the SpotlightTour `step / total` badge. */}
            {card.previewSteps && card.previewSteps.length > 0 ? (
              <ol
                data-testid="tutorial-dialog:preview-steps"
                className="mt-2 space-y-0.5 text-[10.5px] text-muted-foreground"
              >
                {card.previewSteps.map((step, i) => (
                  <li key={`${card.id}-step-${i}`} className="flex gap-1.5">
                    <span
                      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
                      style={{
                        background: "hsl(var(--p-purple-500) / 0.18)",
                        color: "hsl(var(--p-purple-500))",
                      }}
                      aria-hidden
                    >
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {/* U7 — Per-card "실행하기" CTA. Skips the swipe loop and
                jumps straight into the SpotlightTour for this scenario. */}
            <button
              type="button"
              data-testid="tutorial-dialog:run"
              onClick={onRun}
              className={cn(
                "mt-3 w-full rounded-md py-1.5 text-[11.5px] font-semibold text-primary-foreground transition",
                "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
              )}
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
              }}
              disabled={exitDirection !== null}
            >
              실행하기 →
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-5 px-6 pb-4">
        <button
          type="button"
          aria-label="별로예요"
          data-testid="tutorial-dialog:dislike"
          onClick={handleDislikeClick}
          disabled={exitDirection !== null}
          className={cn(
            "grid h-12 w-12 place-items-center rounded-full text-xl transition",
            "bg-destructive/15 border border-destructive/40 text-destructive",
            "hover:bg-destructive/25 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          ✕
        </button>
        <button
          type="button"
          aria-label="되돌리기"
          data-testid="tutorial-dialog:undo"
          disabled={!canUndo || exitDirection !== null}
          onClick={onUndo}
          className={cn(
            "grid h-10 w-10 place-items-center rounded-full text-base transition",
            "bg-card border border-border text-muted-foreground",
            "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          ↺
        </button>
        <button
          type="button"
          aria-label="시도해볼래요"
          data-testid="tutorial-dialog:like"
          onClick={handleLikeClick}
          disabled={exitDirection !== null}
          className={cn(
            "grid h-12 w-12 place-items-center rounded-full text-xl transition",
            "bg-success/15 border border-success/40 text-success",
            "hover:bg-success/25 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          ✓
        </button>
      </div>

      <div className="border-t border-border p-2 text-center text-[10px] text-muted-foreground">
        ↑↓ 키보드 · ⎵ 건너뛰기 · 카드를 좌/우 드래그
      </div>
    </div>
  );
}

interface FinishedSummaryProps {
  cards: readonly DiscoveryCard[];
  history: HistoryEntry[];
  /** U2 — explicit user-gated tour start. Closes dialog + fires tour. */
  onStart: () => void;
  onClose: () => void;
}

function FinishedSummary({ cards, history, onStart, onClose }: FinishedSummaryProps) {
  const likedCards = history
    .filter((entry) => entry.action === "liked")
    .map((entry) => cards[entry.cardIndex])
    .filter((card): card is DiscoveryCard => card !== undefined);

  return (
    <div
      className="flex h-[640px] min-w-0 flex-col"
      data-testid="tutorial-dialog:finished"
    >
      <div
        className="px-4 pt-6 pb-2 text-center"
        // U9 (light) — gradient sweep on entry signals "completed" state.
        style={{
          background:
            "linear-gradient(180deg, hsl(var(--p-purple-500) / 0.10), transparent)",
        }}
      >
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {cards.length} / {cards.length}
        </div>
        <h2 className="mt-1 text-[16px] font-semibold">추천 완료 ✨</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">
          선택하신 시나리오로 LVIS 가이드를 시작합니다. "가이드 시작" 을
          누르면 SpotlightTour 가 단계별로 안내해요.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {likedCards.length > 0 ? (
          <ul className="space-y-2" data-testid="tutorial-dialog:liked-list">
            {likedCards.map((card) => (
              <li
                key={card.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
                data-card-id={card.id}
              >
                <div className="text-2xl">{card.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">
                    {card.title}
                  </div>
                  <div className="truncate text-[10.5px] text-muted-foreground">
                    {card.tags.join(" · ")}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-center text-[11px] text-muted-foreground">
            관심 시나리오를 선택하지 않았습니다. 기본 가이드 투어를 실행합니다.
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-border px-6 py-4">
        <button
          type="button"
          data-testid="tutorial-dialog:start"
          onClick={onStart}
          className={cn(
            "w-full rounded-lg py-2 text-[12px] font-semibold text-primary-foreground transition",
            "hover:opacity-90",
          )}
          style={{
            background:
              "linear-gradient(135deg, hsl(var(--p-purple-500)), hsl(var(--p-blue-500)))",
          }}
        >
          가이드 시작 →
        </button>
        <button
          type="button"
          data-testid="tutorial-dialog:close"
          onClick={onClose}
          className={cn(
            "w-full rounded-lg py-1.5 text-[11px] transition",
            "bg-transparent text-muted-foreground hover:bg-muted",
          )}
        >
          끝내기
        </button>
      </div>
    </div>
  );
}
