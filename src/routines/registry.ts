import type { Routine, RoutineTriggerType } from "../core/routine-engine.js";
import type { RoutineSettings } from "../data/settings-store.js";
import {
  DEFAULT_SHUTDOWN_PROMPT,
  DEFAULT_WAKEUP_ROUTINE_PROMPT,
  normalizeScheduleEntries,
} from "./schedule.js";

export type RegisteredRoutine = {
  id: RoutineTriggerType;
  title: string;
  description: string;
  trigger: RoutineTriggerType;
  configurable: {
    enabled: true;
    scheduleTimeKst?: boolean;
    scheduleEntries?: boolean;
  };
};

export type BuildRoutineFailure = "routine-not-found" | "schedule-no-active-entry";
export type BuildRoutineResult =
  | { ok: true; routine: Routine }
  | { ok: false; error: BuildRoutineFailure };

export const REGISTERED_ROUTINES: RegisteredRoutine[] = [
  {
    id: "wakeup",
    title: "웨이크업 루틴",
    description: "장시간 idle 또는 예약 시각에 오늘의 업무 맥락을 대화 형태로 정리합니다.",
    trigger: "wakeup",
    configurable: { enabled: true, scheduleTimeKst: true },
  },
  {
    id: "schedule",
    title: "스케줄 루틴",
    description: "크론탭 스타일 스케줄에 맞춰 주기적으로 루틴 대화를 실행합니다.",
    trigger: "schedule",
    configurable: { enabled: true, scheduleEntries: true },
  },
  {
    id: "shutdown",
    title: "종료 루틴",
    description: "앱 종료 시 오늘의 업무 흐름을 대화 형태로 정리합니다.",
    trigger: "shutdown",
    configurable: { enabled: true },
  },
];

export function getRegisteredRoutine(routineId: string): RegisteredRoutine | undefined {
  return REGISTERED_ROUTINES.find((routine) => routine.id === routineId);
}

/**
 * Build a fully-formed `Routine` (with prePrompt) from registry metadata +
 * user settings. Used by dev-trigger IPCs and shutdown handler so all
 * manually-fired routines pick up the current settings prompt rather than
 * hardcoded text or undefined.
 *
 * Schedule routines pick the first enabled entry; if none, returns failure.
 */
export function buildRoutineForTrigger(
  routineId: string,
  settings: RoutineSettings | undefined,
): BuildRoutineResult {
  const meta = getRegisteredRoutine(routineId);
  if (!meta) return { ok: false, error: "routine-not-found" };

  if (meta.id === "wakeup") {
    const configured = settings?.wakeupRoutinePrompt;
    const prePrompt = typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_WAKEUP_ROUTINE_PROMPT;
    return { ok: true, routine: { id: meta.id, trigger: meta.trigger, prePrompt, title: meta.title } };
  }

  if (meta.id === "shutdown") {
    const configured = settings?.shutdownPrompt;
    const prePrompt = typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_SHUTDOWN_PROMPT;
    return { ok: true, routine: { id: meta.id, trigger: meta.trigger, prePrompt, title: meta.title } };
  }

  // schedule — pick first enabled entry's prompt
  const entries = normalizeScheduleEntries(settings?.scheduleEntries);
  const active = entries.find((e) => e.enabled);
  if (!active) return { ok: false, error: "schedule-no-active-entry" };
  return {
    ok: true,
    routine: { id: active.id, trigger: meta.trigger, prePrompt: active.prompt, title: meta.title },
  };
}
