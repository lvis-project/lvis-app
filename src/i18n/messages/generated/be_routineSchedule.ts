// AUTO-GENERATED — i18n migration. Source: src/tools/routine-schedule.ts. Do not edit by hand.
export const en = {
  "be_routineSchedule.toolDescription":
    "Registers a routine (automatic self-trigger) that fires at the scheduled time. " +
    "This is NOT a calendar/event query tool — do not use it for requests such as " +
    "'check calendar', 'today's schedule', or 'confirm meeting' (calendar queries are handled by the ms-graph plugin). " +
    "execution='llm-session' starts an LLM conversation at the specified time; " +
    "'notification-only' sends an OS notification only. " +
    "Repeat modes: none/daily/weekly/monthly/interval/cron. " +
    "If only a date is provided for schedule.at (YYYY-MM-DD), the default time 09:00 KST is used. " +
    "Example: daily 9 AM report → execution:'llm-session', " +
    "schedule:{at:'2026-05-09T09:00:00+09:00', repeat:{kind:'daily'}}, " +
    "prePrompt:'Write today\\'s daily report'",
  "be_routineSchedule.executionDescription":
    "Execution mode. llm-session=start LLM conversation, notification-only=notification only",
  "be_routineSchedule.scheduleDescription":
    "Schedule settings. at: ISO 8601 or YYYY-MM-DD. " +
    "repeat.kind: none|daily|weekly|monthly|interval|cron. " +
    "cron type requires only repeat.expression (5-field cron).",
  "be_routineSchedule.atDescription":
    "ISO 8601 datetime (e.g. '2026-05-09T09:00:00+09:00') or YYYY-MM-DD",
  "be_routineSchedule.intervalMsDescription": "interval type only: interval in ms",
  "be_routineSchedule.expressionDescription": "cron type only: 5-field cron expression",
  "be_routineSchedule.prePromptDescription":
    "Initial prompt passed to the LLM when execution=llm-session",
  "be_routineSchedule.titleDescription": "Routine title (optional)",
  "be_routineSchedule.notificationTitleDescription":
    "Notification title when execution=notification-only",
  "be_routineSchedule.notificationBodyDescription":
    "Notification body when execution=notification-only",
  "be_routineSchedule.allowedPluginsDescription":
    "List of plugin IDs to expose in execution=llm-session routines. If omitted or [], no plugin tools are available.",
  "be_routineSchedule.sourceDescription":
    "Optional origin marker for idempotency. Only set this when a system prompt explicitly instructs you to (format 'suggestion:<pluginId>:<intent>'). Leave unset for ordinary user-requested routines.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_routineSchedule.toolDescription":
    "지정한 예약 시각에 발화되는 루틴(자동 self-trigger)을 등록합니다. " +
    "캘린더 일정/이벤트 조회 도구가 아니므로, '캘린더 점검', '오늘 일정', '회의 확인' 같은 " +
    "캘린더/일정 조회 요청에는 사용하지 마십시오 (캘린더 조회는 ms-graph 플러그인). " +
    "execution='llm-session'이면 지정 시각에 LLM 대화를 시작하고, " +
    "'notification-only'이면 OS 알림만 발송합니다. " +
    "반복 방식: none/daily/weekly/monthly/interval/cron. " +
    "schedule.at 에 날짜만 제공(YYYY-MM-DD)하면 기본 시각 09:00 KST 로 처리됩니다. " +
    "예: 매일 오전 9시 데일리 리포트 → execution:'llm-session', " +
    "schedule:{at:'2026-05-09T09:00:00+09:00', repeat:{kind:'daily'}}, " +
    "prePrompt:'오늘의 데일리 리포트 작성'",
  "be_routineSchedule.executionDescription":
    "실행 모드. llm-session=LLM 대화 시작, notification-only=알림만",
  "be_routineSchedule.scheduleDescription":
    "스케줄 설정. at: ISO 8601 or YYYY-MM-DD. " +
    "repeat.kind: none|daily|weekly|monthly|interval|cron. " +
    "cron 타입은 repeat.expression(5필드)만 필요.",
  "be_routineSchedule.atDescription":
    "ISO 8601 datetime (예: '2026-05-09T09:00:00+09:00') 또는 YYYY-MM-DD",
  "be_routineSchedule.intervalMsDescription": "interval 타입 전용: ms 단위 간격",
  "be_routineSchedule.expressionDescription": "cron 타입 전용: 5필드 cron 표현식",
  "be_routineSchedule.prePromptDescription":
    "execution=llm-session 시 LLM에 전달할 초기 프롬프트",
  "be_routineSchedule.titleDescription": "루틴 제목 (선택)",
  "be_routineSchedule.notificationTitleDescription":
    "execution=notification-only 시 알림 제목",
  "be_routineSchedule.notificationBodyDescription":
    "execution=notification-only 시 알림 본문",
  "be_routineSchedule.allowedPluginsDescription":
    "execution=llm-session 루틴에서 노출할 플러그인 id 목록. 미지정 또는 []이면 플러그인 도구를 사용하지 않습니다.",
  "be_routineSchedule.sourceDescription":
    "멱등성용 출처 마커(선택). 시스템 프롬프트가 명시적으로 지시할 때만 설정하십시오(형식 'suggestion:<pluginId>:<intent>'). 일반 사용자 요청 루틴에서는 미설정.",
};
