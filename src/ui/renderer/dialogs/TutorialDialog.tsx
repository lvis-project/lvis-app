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

  // When the deck empties, dispatch the chosen scenario exactly once.
  React.useEffect(() => {
    if (!open || !finished || submitted) return;
    const likedIds = new Set(
      history.filter((h) => h.action === "liked").map((h) => h.cardIndex),
    );
    const preferred = cards.find((_, idx) => likedIds.has(idx));
    const scenarioId = preferred ? resolveScenarioId(preferred) : FALLBACK_SCENARIO_ID;
    setSubmitted(true);
    void api.tour.start(scenarioId).catch(() => {
      /* renderer keeps the summary visible even if the dispatch fails */
    });
  }, [open, finished, submitted, history, cards, api]);

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
          />
        ) : (
          <FinishedSummary
            cards={cards}
            history={history}
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
}

function ActiveDeck({
  card,
  cards,
  cursor,
  onLike,
  onDislike,
  onUndo,
  canUndo,
}: ActiveDeckProps) {
  const total = cards.length;
  const reduceMotion = usePrefersReducedMotion();

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
          ⬆ 시도해볼래요 · ⬇ 별로예요 · ⎵ 건너뛰기 · z 되돌리기
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
        {/* top card */}
        <div
          data-testid="tutorial-dialog:top-card"
          data-card-id={card.id}
          className={cn(
            "relative w-[90%] overflow-hidden rounded-2xl border bg-card",
            "border-[hsl(var(--p-purple-500)/0.5)]",
            "shadow-[0_20px_50px_-10px_hsl(var(--p-purple-500)/0.3)]",
            "ring-1 ring-[hsl(var(--p-purple-500)/0.6)]",
          )}
        >
          <div
            className="flex h-32 items-center justify-center text-5xl"
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
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-5 px-6 pb-4">
        <button
          type="button"
          aria-label="별로예요"
          data-testid="tutorial-dialog:dislike"
          onClick={onDislike}
          className={cn(
            "grid h-12 w-12 place-items-center rounded-full text-xl transition",
            "bg-destructive/15 border border-destructive/40 text-destructive",
            "hover:bg-destructive/25",
          )}
        >
          ✕
        </button>
        <button
          type="button"
          aria-label="되돌리기"
          data-testid="tutorial-dialog:undo"
          disabled={!canUndo}
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
          onClick={onLike}
          className={cn(
            "grid h-12 w-12 place-items-center rounded-full text-xl transition",
            "bg-success/15 border border-success/40 text-success",
            "hover:bg-success/25",
          )}
        >
          ✓
        </button>
      </div>

      <div className="border-t border-border p-2 text-center text-[10px] text-muted-foreground">
        ↑↓ 키보드 · 또는 ⎵ 로 건너뛰기
      </div>
    </div>
  );
}

interface FinishedSummaryProps {
  cards: readonly DiscoveryCard[];
  history: HistoryEntry[];
  onClose: () => void;
}

function FinishedSummary({ cards, history, onClose }: FinishedSummaryProps) {
  const likedCards = history
    .filter((entry) => entry.action === "liked")
    .map((entry) => cards[entry.cardIndex])
    .filter((card): card is DiscoveryCard => card !== undefined);

  return (
    <div
      className="flex h-[640px] min-w-0 flex-col"
      data-testid="tutorial-dialog:finished"
    >
      <div className="px-4 pt-6 pb-2 text-center">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {cards.length} / {cards.length}
        </div>
        <h2 className="mt-1 text-[16px] font-semibold">추천 완료</h2>
        <p className="mt-1 text-[11px] text-muted-foreground">
          선택하신 시나리오로 LVIS 가이드를 시작합니다.
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

      <div className="border-t border-border px-6 py-4">
        <button
          type="button"
          data-testid="tutorial-dialog:close"
          onClick={onClose}
          className={cn(
            "w-full rounded-lg py-2 text-[12px] font-semibold transition",
            "bg-primary text-primary-foreground hover:opacity-90",
          )}
        >
          가이드 시작
        </button>
      </div>
    </div>
  );
}
