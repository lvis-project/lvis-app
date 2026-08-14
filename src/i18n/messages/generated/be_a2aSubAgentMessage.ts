// AUTO-GENERATED — i18n migration. Source: src/engine/a2a-subagent-message-codec.ts. Do not edit by hand.
export const en = {
  "be_a2aSubAgentMessage.emptyBodyFallback":
    "This sub-agent report arrived with no content. Task state: {taskState}. "
    + "Resume the sub-agent with agent_spawn(resumeId: \"{resumeId}\") to find out what it did, "
    + "or state explicitly why no further work is needed.",
  "be_a2aSubAgentMessage.parentJudgmentInstruction":
    "[Host] The following is a report from a sub-agent you started. Review it explicitly before "
    + "this turn ends, then do one of: (a) act on it and answer, (b) resume the sub-agent with "
    + "agent_spawn(resumeId) if the work is unfinished, or (c) state that the work is complete and "
    + "why. Do not end the turn without addressing it.",
} as const;

export const ko: Record<keyof typeof en, string> = {
  "be_a2aSubAgentMessage.emptyBodyFallback":
    "이 서브에이전트 보고는 본문 없이 도착했다. 작업 상태: {taskState}. "
    + "agent_spawn(resumeId: \"{resumeId}\") 로 서브에이전트를 재개해 무엇을 했는지 확인하거나, "
    + "추가 작업이 필요 없는 이유를 명시하라.",
  "be_a2aSubAgentMessage.parentJudgmentInstruction":
    "[호스트] 아래는 당신이 시작한 서브에이전트의 보고다. 이번 턴이 끝나기 전에 반드시 명시적으로 "
    + "검토하고 (a) 내용에 따라 조치하고 답하거나, (b) 작업이 끝나지 않았으면 "
    + "agent_spawn(resumeId) 로 서브에이전트를 재개하거나, (c) 작업이 완료되었음과 그 근거를 "
    + "밝혀라. 이를 다루지 않은 채 턴을 끝내지 마라.",
};
