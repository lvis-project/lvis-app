// AUTO-GENERATED — i18n migration. Source: src/tools/agent-list.ts. Do not edit by hand.
export const en = {
  "be_agentList.toolDescription":
    "Returns the available LVIS agent profiles AND this conversation's existing sub-agents (with their resumeId and state). Call this before agent_spawn: when asked to continue existing agents, resume the listed resumable entries with agent_spawn with their resumeId instead of spawning fresh ones.",
  "be_agentList.existingGuidance":
    "These sub-agents already exist in THIS conversation. To continue one, call agent_spawn with its resumeId — it keeps its full history and continues where it stopped. Spawning a fresh agent for work an existing resumable agent already carries discards that agent's context.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_agentList.toolDescription":
    "사용 가능한 LVIS agent profile 과 함께 이 대화의 기존 sub-agent 목록(resumeId·상태 포함)을 반환합니다. agent_spawn 전에 호출하세요: 기존 에이전트를 이어가라는 요청이면 새로 띄우지 말고 목록의 resumable 항목을 resumeId 를 지정한 agent_spawn 로 재개하세요.",
  "be_agentList.existingGuidance":
    "이 sub-agent 들은 이 대화에 이미 존재합니다. 이어가려면 해당 resumeId 로 agent_spawn 을 호출하세요 — 전체 히스토리를 유지한 채 중단 지점부터 계속합니다. 재개 가능한 기존 에이전트가 이미 맡은 작업에 새 에이전트를 띄우면 그 에이전트의 컨텍스트를 버리게 됩니다.",
};
