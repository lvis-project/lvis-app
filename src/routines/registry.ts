import type { RoutineTriggerType } from "../core/routine-engine.js";

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
