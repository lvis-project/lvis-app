// OverlayCard — overlay card for routine fire and plugin (insertion-type) triggers.
//
// Two source variants share the same card shell:


//
// Policy:
//   - Single active card with prev/next queue navigation
//   - queueIndex / queueTotal counter (shown when queue ≥ 2)
//   - dismiss (X) — permanent removal
//   - snooze removed (production smoke test: UX risk)
//   - a proposal card ANSWERS instead of confirming (see `dispositions`). That
//     is not the snooze above returning: a snooze re-showed a result nobody had
//     been asked about, on a timer; an answer is what the user gives to a
//     question the card put to them, and the host stores it.
//
// Isolation: only summary and session id flow here. Full content stays in the
// normal conversation session model.
//

// summary + actions. Transitions to done phase when running flips to false.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card.js";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatMediumDateTime, formatRelativeTime, type RelativeTimeLabels } from "../../../shared/format-time.js";

export interface OverlayCardProps {
  /** Card title — routine name or plugin-supplied title */
  title: string;
  summary: string;
  firedAt: string;
  /** true = LLM session in-flight; false = session complete or plugin proposal */
  running: boolean;
  /** 1-based index within visible queue */
  queueIndex: number;
  /** Total visible queue length */
  queueTotal: number;
  onPrev: () => void;
  onNext: () => void;
  onDismiss: () => void;
  /**
   * Called when the user clicks the primary action button.
   * When undefined, the primary action button is not rendered
   * (e.g. notification-only routine with no conversation session, or a staged
   * card whose origin conversation is no longer open).
   */
  onPrimaryAction?: () => void;

  primaryActionLabel?: string;

  /**
   * Why this card has no primary action, in the user's words. Rendered in
   * place of the action so a card that can only be dismissed says so.
   */
  notice?: string;

  /**
   * Whether the summary is expanded, and how to change it.
   *
   * Controlled by the overlay queue rather than held here: the card unmounts
   * when it moves between tiles, and local state would collapse the summary
   * the user just opened.
   */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;

  /** `app` = an MCP App's `ui/message` staged for user confirmation (no turn in flight). */
  kind?: "routine" | "plugin" | "app";

  /**
   * A proposal is a question the user answers ONCE, so its card carries the
   * answer instead of a single confirm: `onAccept` runs the proposed action,
   * and the two refusals differ in whether the question may come back.
   *
   * This is not the snooze the header says was removed. A snooze re-showed a
   * RESULT the user had already been handed, on a timer, having asked nothing;
   * these three are the answers to a question that WAS asked, and the host
   * stores whichever one it gets. When set, they replace the single primary
   * action — `primaryActionLabel` is then the accept label, supplied by the
   * proposing plugin.
   */
  dispositions?: {
    onAccept: () => void;
    onLater: () => void;
    onNever: () => void;
  };
}

function relativeTimeLabels(t: (key: string, vars?: Record<string, string | number>) => string): RelativeTimeLabels {
  return {
    justNow: () => t("overlayCard.justNow"),
    secondsAgo: (count) => t("overlayCard.secondsAgo", { count }),
    minutesAgo: (count) => t("overlayCard.minutesAgo", { count }),
    hoursAgo: (count) => t("overlayCard.hoursAgo", { count }),
    daysAgo: (count) => t("overlayCard.daysAgo", { count }),
  };
}

export function OverlayCard({
  title,
  summary,
  firedAt,
  running,
  queueIndex,
  queueTotal,
  onPrev,
  onNext,
  onDismiss,
  onPrimaryAction,
  primaryActionLabel,
  notice,
  expanded,
  onExpandedChange,
  kind = "routine",
  dispositions,
}: OverlayCardProps) {
  const { t } = useTranslation();
  const [isOverflowing, setIsOverflowing] = useState(false);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const relTime = useMemo(() => formatRelativeTime(firedAt, relativeTimeLabels(t)), [firedAt, t]);



  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el || expanded) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [summary, expanded]);

  const isoLabel = useMemo(() => {
    try {
      return formatMediumDateTime(firedAt);
    } catch {
      return firedAt;
    }
  }, [firedAt]);

  const showNav = queueTotal >= 2;

  return (
    <Card
      data-testid="routine-card"
      className="flex flex-col border-action-view/(--opacity-medium) bg-action-view/(--opacity-faint) shadow-md backdrop-blur lvis-anim-slide-down"
      role="status"
      aria-live="polite"
      aria-atomic
    >
      <CardHeader className="shrink-0 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-action-view" />
              ) : (
                <span className="text-action-view">●</span>
              )}
              <span className="truncate">{title}</span>
            </CardTitle>
            <CardDescription className="mt-0.5 flex items-center gap-1 text-[11px]">
              <span>
                {running
                  ? t("overlayCard.running")
                  : kind === "plugin"
                    ? t("overlayCard.pluginNotice")
                    : kind === "app"
                      ? t("overlayCard.appNotice")
                      : t("overlayCard.routineDone")}
              </span>
              {!running && (
                <>
                  <span>·</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default">{relTime}</span>
                    </TooltipTrigger>
                    <TooltipContent>{isoLabel}</TooltipContent>
                  </Tooltip>
                </>
              )}
              {showNav && (
                <>
                  <span>·</span>
                  <span
                    data-testid="routine-card-indicator"
                    className="text-action-view"
                  >
                    {queueIndex}/{queueTotal}
                  </span>
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {showNav && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  data-testid="overlay-card-prev"
                  aria-label={t("overlayCard.prevAriaLabel")}
                  disabled={queueIndex <= 1}
                  onClick={onPrev}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  data-testid="overlay-card-next"
                  aria-label={t("overlayCard.nextAriaLabel")}
                  disabled={queueIndex >= queueTotal}
                  onClick={onNext}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              data-testid="routine-card-dismiss"
              aria-label={t("overlayCard.closeAriaLabel")}
              onClick={onDismiss}
            >
              <X className="h-3.5 w-3.5" />
              {t("overlayCard.closeButton")}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 overflow-hidden pt-0">
        {running ? (
          <p className="text-xs text-muted-foreground/(--opacity-stronger)">{t("overlayCard.runningDescription")}</p>
        ) : summary ? (
          <>
            <p
              ref={summaryRef}
              className={
                expanded
                  ? "max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground"
                  : "line-clamp-2 break-words text-xs text-muted-foreground"
              }
              data-testid="overlay-card-summary"
              data-expanded={expanded}
            >
              {summary}
            </p>
            {(isOverflowing || expanded) && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 h-6 gap-1 px-1 text-[11px] text-muted-foreground hover:text-foreground"
                data-testid="overlay-card-expand-toggle"
                aria-expanded={expanded}
                onClick={() => onExpandedChange(!expanded)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    {t("overlayCard.collapseButton")}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    {t("overlayCard.expandButton")}
                  </>
                )}
              </Button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground/(--opacity-half)">{t("overlayCard.noSummary")}</p>
        )}
        {!running && dispositions && (
          <div
            className="mt-2 flex flex-wrap items-center justify-end gap-1.5"
            data-testid="overlay-card-dispositions"
          >
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              data-testid="overlay-card-disposition-never"
              onClick={dispositions.onNever}
            >
              {t("overlayCard.proposalNeverButton")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              data-testid="overlay-card-disposition-later"
              onClick={dispositions.onLater}
            >
              {t("overlayCard.proposalLaterButton")}
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              data-testid="overlay-card-disposition-accept"
              onClick={dispositions.onAccept}
            >
              {primaryActionLabel ?? t("overlayCard.pluginPrimaryAction")}
            </Button>
          </div>
        )}
        {!running && !dispositions && !onPrimaryAction && notice && (
          <p
            data-testid="overlay-card-notice"
            className="mt-2 text-[11px] text-muted-foreground/(--opacity-stronger)"
          >
            {notice}
          </p>
        )}
        {!running && !dispositions && onPrimaryAction && (
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              data-testid="overlay-card-primary-action"
              onClick={onPrimaryAction}
            >
              {primaryActionLabel ?? (kind === "plugin" ? t("overlayCard.pluginPrimaryAction") : t("overlayCard.routinePrimaryAction"))}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
