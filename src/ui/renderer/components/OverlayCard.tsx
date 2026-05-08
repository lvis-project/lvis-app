// OverlayCard — routine fire inline overlay card.
//
// Inherits v1 RoutineCard policy:
//   - Single active card with prev/next queue navigation
//   - queueIndex / queueTotal counter (shown when queue ≥ 2)
//   - dismiss (X) — permanent removal
//   - snooze (clock icon) — default 30 min, re-enters queue on expiry
//   - "결과 보기" opens RoutineSessionView modal
//
// Q9 isolation: only ~200ch summary flows here. Full content
// lives in RoutineSessionView which reads the JSONL directly.

import { useMemo } from "react";
import { ChevronLeft, ChevronRight, Clock, X } from "lucide-react";
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

export interface OverlayCardProps {
  routineTitle: string;
  summary: string;
  firedAt: string;
  /** 1-based index within visible queue */
  queueIndex: number;
  /** Total visible queue length */
  queueTotal: number;
  onPrev: () => void;
  onNext: () => void;
  onDismiss: () => void;
  onSnooze: () => void;
  onOpenSession: () => void;
}

function relativeTime(isoString: string): string {
  try {
    const diffMs = Date.now() - new Date(isoString).getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}초 전`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}분 전`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}시간 전`;
    return `${Math.floor(diffHr / 24)}일 전`;
  } catch {
    return isoString;
  }
}

export function OverlayCard({
  routineTitle,
  summary,
  firedAt,
  queueIndex,
  queueTotal,
  onPrev,
  onNext,
  onDismiss,
  onSnooze,
  onOpenSession,
}: OverlayCardProps) {
  const relTime = useMemo(() => relativeTime(firedAt), [firedAt]);

  const isoLabel = useMemo(() => {
    try {
      return new Date(firedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    } catch {
      return firedAt;
    }
  }, [firedAt]);

  const showNav = queueTotal >= 2;

  return (
    <Card
      data-testid="overlay-card"
      className="flex flex-col border-violet-500/40 bg-violet-500/5 shadow-md backdrop-blur"
      role="status"
      aria-live="polite"
      aria-atomic
    >
      <CardHeader className="shrink-0 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <span className="text-violet-500">●</span>
              <span className="truncate">{routineTitle}</span>
            </CardTitle>
            <CardDescription className="mt-0.5 flex items-center gap-1 text-[11px]">
              <span>루틴 완료</span>
              <span>·</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">{relTime}</span>
                </TooltipTrigger>
                <TooltipContent>{isoLabel}</TooltipContent>
              </Tooltip>
              {showNav && (
                <>
                  <span>·</span>
                  <span
                    data-testid="overlay-card-queue-counter"
                    className="text-violet-600 dark:text-violet-400"
                  >
                    {queueIndex} / {queueTotal}
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
                  aria-label="이전"
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
                  aria-label="다음"
                  disabled={queueIndex >= queueTotal}
                  onClick={onNext}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  data-testid="overlay-card-snooze"
                  aria-label="30분 후 다시 알림"
                  onClick={onSnooze}
                >
                  <Clock className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>30분 후 다시 알림</TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              data-testid="overlay-card-dismiss"
              aria-label="닫기"
              onClick={onDismiss}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 overflow-hidden pt-0">
        {summary ? (
          <p className="line-clamp-2 break-words text-xs text-muted-foreground">{summary}</p>
        ) : (
          <p className="text-xs text-muted-foreground/50">요약 없음</p>
        )}
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs"
            data-testid="overlay-card-open-session"
            onClick={onOpenSession}
          >
            결과 보기
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
