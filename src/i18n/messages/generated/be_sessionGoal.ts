// AUTO-GENERATED — i18n migration. Source: src/tools/session-goal.ts. Do not edit by hand.
export const en = {
  "be_sessionGoal.toolDescription": "The objective this session is working towards. " +
    "One call does both jobs: with no goal registered yet it sets one, and with a goal already registered it updates it. " +
    "While a goal is running the session revives itself after every turn ends and keeps working on it, up to the revival ceiling reported back to you. " +
    "Call this with status=\"complete\" the moment the goal is actually met — that is what ENDS the revival loop; nothing else stops it on your behalf. " +
    "status=\"pause\" suspends the loop and status=\"resume\" continues it from the same round count. " +
    "Every call answers with the goal text, its status, the rounds spent and the ceiling, so you never have to remember them.",
  "be_sessionGoal.goalDesc": "The objective, in one or two sentences. Sets the goal when there is none, replaces the text when there is. Rounds already spent are kept.",
  "be_sessionGoal.statusDesc": "complete (the goal is met — stops the revival loop) | pause (suspend it) | resume (continue from the round it paused at).",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_sessionGoal.toolDescription": "이 세션이 달성하려는 목표입니다. " +
    "한 번의 호출이 두 가지 일을 합니다. 등록된 목표가 없으면 새로 설정하고, 이미 있으면 갱신합니다. " +
    "목표가 진행 중이면 세션은 매 턴이 끝날 때마다 스스로 되살아나 계속 작업하며, 응답으로 돌려주는 재개 한도까지 반복합니다. " +
    "목표가 실제로 달성된 순간에 status=\"complete\" 로 호출하세요. 재개 루프를 끝내는 것은 이 호출이며, 다른 무엇도 대신 멈춰주지 않습니다. " +
    "status=\"pause\" 는 루프를 중단하고, status=\"resume\" 은 중단된 회차부터 이어갑니다. " +
    "모든 호출은 목표 문구, 상태, 사용한 회차, 한도를 함께 돌려주므로 직접 기억할 필요가 없습니다.",
  "be_sessionGoal.goalDesc": "달성하려는 목표를 한두 문장으로 적습니다. 목표가 없으면 새로 설정하고, 있으면 문구를 교체합니다. 이미 사용한 회차는 그대로 유지됩니다.",
  "be_sessionGoal.statusDesc": "complete (목표 달성 — 재개 루프 종료) | pause (중단) | resume (중단된 회차부터 재개).",
};
