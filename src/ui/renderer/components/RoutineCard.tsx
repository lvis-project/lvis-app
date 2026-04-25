// RoutineCard — dismissable routine result card (RoutineResult.summary 전용).

import { useMemo } from "react";
import { Button } from "../../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";

const TRIGGER_LABEL: Record<string, string> = {
  wakeup: "웨이크업 루틴",
  shutdown: "종료 루틴",
  schedule: "스케줄 루틴",
};

export function RoutineCard({
  result,
  onDismiss,
  onSnooze,
}: {
  result: { routineId: string; trigger: string; summary: string; generatedAt: string };
  onDismiss: () => void;
  onSnooze: () => void;
}) {
  const generatedLabel = useMemo(() => {
    try {
      return new Date(result.generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    } catch {
      return result.generatedAt;
    }
  }, [result.generatedAt]);

  const triggerLabel = TRIGGER_LABEL[result.trigger] ?? result.trigger;

  return (
    <Card data-testid="routine-card" className="border-primary/40 bg-primary/5">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">{triggerLabel}</CardTitle>
            <CardDescription className="text-[11px]">{generatedLabel}</CardDescription>
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onSnooze}>1시간 뒤 다시</Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onDismiss}>닫기</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {result.summary ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{result.summary}</p>
        ) : (
          <p className="text-xs text-muted-foreground">루틴 결과가 없습니다.</p>
        )}
      </CardContent>
    </Card>
  );
}
