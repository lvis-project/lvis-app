// OverlayCard — overlay card for routine fire and plugin (insertion-type) triggers.
//
// Two source variants share the same card shell:
//   - routine: running=true shows spinner, false shows "결과 보기" (only when jsonl exists)
//   - plugin insertion: running=false shows primaryActionLabel ("확인하기")
//
// Policy:
//   - Single active card with prev/next queue navigation
//   - queueIndex / queueTotal counter (shown when queue ≥ 2)
//   - dismiss (X) — permanent removal
//   - snooze removed (production smoke test: UX risk)
//
// Isolation: only ~200ch summary flows here. Full content
// lives in RoutineSessionView which reads the JSONL directly.
//
// C1: running phase — when running=true shows spinner + "진행 중…" instead of
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
   * (e.g. notification-only routine with no JSONL session).
   */
  onPrimaryAction?: () => void;
  /** Label for the primary action button — e.g. "결과 보기" or "확인하기" */
  primaryActionLabel?: string;
  /** Source kind — drives status label when not running ("루틴 완료" vs "플러그인 알림") */
  kind?: "routine" | "plugin";
}

function relativeTime(isoString: string): string {
  try {
    const t = new Date(isoString).getTime();
    if (!Number.isFinite(t)) return "";
    const diffMs = Date.now() - t;
    if (diffMs < 0) return "방금"; // future timestamp (clock skew) — clamp
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}초 전`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}분 전`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}시간 전`;
    return `${Math.floor(diffHr / 24)}일 전`;
  } catch {
    return "";
  }
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
  kind = "routine",
}: OverlayCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const relTime = useMemo(() => relativeTime(firedAt), [firedAt]);

  // Layout 측정으로 정확한 truncation 감지 — `scrollHeight > clientHeight`
  // 비교. CSS `line-clamp-2` 의 실제 overflow 여부를 폰트/너비 기반으로
  // 측정. 휴리스틱 (newline≥2 || length>120) 의 false-positive (짧지만
  // 줄바꿈 많은 컨텐츠 — "더 보기" 무효 클릭) 와 false-negative (긴
  // 단일라인 < 120자 — 잘리지만 버튼 안 보임) 양쪽 다 회피.
  useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el || expanded) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [summary, expanded]);

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
      data-testid="routine-card"
      className="flex flex-col border-action-view/40 bg-action-view/5 shadow-md backdrop-blur lvis-anim-slide-down"
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
              <span>{running ? "진행 중…" : kind === "plugin" ? "플러그인 알림" : "루틴 완료"}</span>
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
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              data-testid="routine-card-dismiss"
              aria-label="닫기"
              onClick={onDismiss}
            >
              <X className="h-3.5 w-3.5" />
              닫기
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 overflow-hidden pt-0">
        {running ? (
          <p className="text-xs text-muted-foreground/70">루틴 실행 중입니다. 잠시 기다려 주세요.</p>
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
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    접기
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    더 보기
                  </>
                )}
              </Button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground/50">요약 없음</p>
        )}
        {!running && onPrimaryAction && (
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              data-testid="overlay-card-primary-action"
              onClick={onPrimaryAction}
            >
              {primaryActionLabel ?? (kind === "plugin" ? "확인하기" : "결과 보기")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
