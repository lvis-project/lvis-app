// RoutineCard — dismissable routine result card with stack navigation.

import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";

const TRIGGER_LABEL: Record<string, string> = {
  wakeup: "웨이크업 루틴",
  shutdown: "종료 루틴",
  schedule: "스케줄 루틴",
};

const SNOOZE_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: "15분 뒤", ms: 15 * 60_000 },
  { label: "1시간 뒤", ms: 60 * 60_000 },
  { label: "3시간 뒤", ms: 3 * 60 * 60_000 },
];

export function RoutineCard({
  result,
  onDismiss,
  onSnooze,
  index = 0,
  total = 1,
  onPrev,
  onNext,
}: {
  result: { routineId: string; trigger: string; summary: string; generatedAt: string };
  onDismiss: () => void;
  onSnooze: (durationMs: number) => void;
  /** 0-based position of this card in the queue. */
  index?: number;
  /** Total cards in the queue. When > 1, prev/next chevrons render. */
  total?: number;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const generatedLabel = useMemo(() => {
    try {
      return new Date(result.generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    } catch {
      return result.generatedAt;
    }
  }, [result.generatedAt]);

  const triggerLabel = TRIGGER_LABEL[result.trigger] ?? result.trigger;
  const showNav = total > 1;

  return (
    <Card
      data-testid="routine-card"
      className="flex h-full flex-col border-primary/40 bg-primary/5 shadow-lg backdrop-blur"
    >
      <CardHeader className="shrink-0 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            {showNav && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={onPrev}
                disabled={index <= 0}
                aria-label="이전 루틴"
                data-testid="routine-card-prev"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            <div>
              <CardTitle className="text-sm">
                {triggerLabel}
                {showNav && (
                  <span
                    className="ml-2 text-[11px] font-normal text-muted-foreground"
                    data-testid="routine-card-indicator"
                  >
                    {index + 1}/{total}
                  </span>
                )}
              </CardTitle>
              <CardDescription className="text-[11px]">{generatedLabel}</CardDescription>
            </div>
            {showNav && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={onNext}
                disabled={index >= total - 1}
                aria-label="다음 루틴"
                data-testid="routine-card-next"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div className="flex gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid="routine-card-snooze-trigger">
                  나중에 다시
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SNOOZE_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.ms}
                    onSelect={() => onSnooze(opt.ms)}
                    data-testid={`routine-card-snooze-${opt.ms}`}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onDismiss}>닫기</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto pt-0">
        {result.summary ? (
          <div className="prose prose-sm lvis-prose max-w-none break-words">
            <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]}>{result.summary}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">루틴 결과가 없습니다.</p>
        )}
      </CardContent>
    </Card>
  );
}
