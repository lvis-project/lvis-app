import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";

type RunningRoutineEntry = {
  routineId: string;
  trigger: string;
  startedAt: string;
};

/**
 * 루틴 실행 중 상태 훅.
 * `lvis:routine:started` 구독 → 실행 중 항목 추가.
 * `lvis:routine:completed` 구독 → 완료 시 해당 항목 제거.
 */
export function useRoutineRunning(api: LvisApi) {
  const [runningRoutines, setRunningRoutines] = useState<Map<string, RunningRoutineEntry>>(new Map());

  useEffect(() => {
    const unsubscribeStarted = api.onRoutineStarted((payload) => {
      setRunningRoutines((current) => {
        const next = new Map(current);
        next.set(payload.routineId, payload);
        return next;
      });
    });

    const unsubscribeCompleted = api.onRoutineCompleted((result) => {
      setRunningRoutines((current) => {
        const next = new Map(current);
        next.delete(result.routineId);
        return next;
      });
    });

    return () => {
      unsubscribeStarted();
      unsubscribeCompleted();
    };
  }, [api]);

  return { runningRoutines };
}
