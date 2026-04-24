export type RegisteredRoutine = {
  id: "daily-briefing" | "heartbeat" | "shutdown-summary";
  title: string;
  description: string;
  trigger: "wakeup" | "heartbeat" | "shutdown";
  configurable: {
    enabled: true;
    scheduleTimeKst?: boolean;
    heartbeatEntries?: boolean;
    postTurnEnabled?: boolean;
  };
};

export const REGISTERED_ROUTINES: RegisteredRoutine[] = [
  {
    id: "daily-briefing",
    title: "데일리 브리핑",
    description: "장시간 idle 또는 예약 시각에 오늘의 업무 맥락을 요약하며, 홈 브리핑 카드와 루틴 대화에 함께 남깁니다.",
    trigger: "wakeup",
    configurable: { enabled: true, scheduleTimeKst: true, postTurnEnabled: true },
  },
  {
    id: "heartbeat",
    title: "하트비트",
    description: "크론탭 스타일 스케줄에 맞춰 proactive 컨텍스트를 주기적으로 갱신합니다.",
    trigger: "heartbeat",
    configurable: { enabled: true, heartbeatEntries: true },
  },
  {
    id: "shutdown-summary",
    title: "종료 요약",
    description: "앱 종료 시 오늘의 업무 흐름을 요약합니다.",
    trigger: "shutdown",
    configurable: { enabled: true },
  },
];

export function getRegisteredRoutine(routineId: string): RegisteredRoutine | undefined {
  return REGISTERED_ROUTINES.find((routine) => routine.id === routineId);
}
