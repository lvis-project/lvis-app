import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

type RoutineResult = {
  routineId: string;
  trigger: string;
  summary: string;
  generatedAt: string;
};

/**
 * Phase 3.3 — routine result state hook.
 *
 * Subscribes to `lvis:routine:completed` IPC and exposes the latest
 * RoutineResult. dismiss / snooze clear the local display state.
 */
export function useRoutineResult(api: LvisApi) {
  const [routineResult, setRoutineResult] = useState<RoutineResult | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const unsubscribe = api.onRoutineCompleted((result) => {
      if (aliveRef.current) setRoutineResult(result);
    });
    void api.getLatestRoutineResult().then((latest) => {
      if (!aliveRef.current || !latest) return;
      setRoutineResult((current) => current ?? latest);
    }).catch((e: Error) => {
      console.warn("[lvis] getLatestRoutineResult failed:", e.message);
    });
    return () => {
      aliveRef.current = false;
      unsubscribe();
    };
  }, [api]);

  const dismiss = useCallback(
    () => {
      if (aliveRef.current) setRoutineResult(null);
    },
    [],
  );

  const snooze = useCallback(() => {
    if (aliveRef.current) setRoutineResult(null);
  }, []);

  return { routineResult, dismiss, snooze };
}
