// AUTO-GENERATED — i18n migration. Source: src/main/session-goal-revival.ts. Do not edit by hand.
export const en = {
  "be_sessionGoalRevival.input": "The session goal is still open, so this session woke itself to keep working on it. " +
    "This is revival round {round} of {ceiling}.\n\nGoal: {goal}\n\n" +
    "Take the next concrete step towards the goal now. " +
    "The moment the goal is actually met, call session_goal with status=\"complete\" — that is the only thing that ends these revivals. " +
    "If the goal cannot be advanced without the user, call session_goal with status=\"pause\" and say what you need.",
  "be_sessionGoalRevival.note": "Continuing the goal {round}/{ceiling}",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_sessionGoalRevival.input": "세션 목표가 아직 열려 있어 이 세션이 스스로 깨어나 작업을 이어갑니다. " +
    "지금은 {ceiling} 회 중 {round} 번째 재개입니다.\n\n목표: {goal}\n\n" +
    "목표를 향한 다음 구체적인 단계를 지금 수행하세요. " +
    "목표가 실제로 달성된 순간 session_goal 을 status=\"complete\" 로 호출하세요. 재개를 끝내는 것은 그 호출뿐입니다. " +
    "사용자 없이는 목표를 진전시킬 수 없으면 session_goal 을 status=\"pause\" 로 호출하고 무엇이 필요한지 밝히세요.",
  "be_sessionGoalRevival.note": "목표 계속 진행 {round}/{ceiling}",
};
