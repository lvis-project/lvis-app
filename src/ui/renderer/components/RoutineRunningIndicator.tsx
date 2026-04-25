import { Loader2 } from "lucide-react";

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
  if (runningRoutines.size === 0) return null;

  const entries = Array.from(runningRoutines.values());
  const first = entries[0];
  const label = TRIGGER_LABEL[first.trigger] ?? first.trigger;

  return (
    <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">
      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
      <span>
        {`🔄 ${label} 루틴 실행 중...`}
        {entries.length > 1 ? ` (+${entries.length - 1}개)` : ""}
      </span>
    </div>
  );
}
