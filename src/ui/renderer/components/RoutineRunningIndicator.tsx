import { Loader2 } from "lucide-react";
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.js";

type RunningRoutineEntry = {
  routineId: string;
  trigger: string;
  startedAt: string;
};

interface RoutineRunningIndicatorProps {
  runningRoutines: Map<string, RunningRoutineEntry>;
}

const TRIGGER_LABEL: Record<string, string> = {
  wakeup: "웨이크업",
  schedule: "스케줄",
  shutdown: "종료",
};

export function RoutineRunningIndicator({ runningRoutines }: RoutineRunningIndicatorProps) {
  const first = useMemo(() => {
    if (runningRoutines.size === 0) return null;
    return runningRoutines.values().next().value as RunningRoutineEntry;
  }, [runningRoutines]);

  if (!first) return null;

  const label = TRIGGER_LABEL[first.trigger] ?? first.trigger;
  const extraCount = runningRoutines.size - 1;
  const startedLabel = (() => {
    try {
      return new Date(first.startedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    } catch {
      return first.startedAt;
    }
  })();

  return (
    <Card
      data-testid="routine-running-card"
      className="flex h-full flex-col border-primary/40 bg-primary/5 shadow-lg backdrop-blur"
    >
      <CardHeader className="shrink-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {`${label} 루틴 실행 중...`}
          {extraCount > 0 ? (
            <span className="text-xs font-normal text-muted-foreground">+{extraCount}개</span>
          ) : null}
        </CardTitle>
        <CardDescription className="text-[11px]">{startedLabel}</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto pt-0">
        <p className="text-xs text-muted-foreground">사용자 컨텍스트(메일/일정/회의)를 모으고 정리하는 중입니다.</p>
      </CardContent>
    </Card>
  );
}
