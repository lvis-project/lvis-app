// AUTO-GENERATED — i18n migration. Source: src/tools/agent-list.ts. Do not edit by hand.
export const en = {
  "be_agentList.toolDescription":
    "Returns the available LVIS agent profiles AND this conversation's existing sub-agents (with their resumeId and state). Call this before agent_spawn: when asked to continue existing agents, resume the listed resumable entries with agent_spawn with their resumeId instead of spawning fresh ones. Sub-agents persisted from this conversation appear here after an app restart too — agent_status lists live runs only.",
  "be_agentList.existingGuidance":
    "These sub-agents already exist in THIS conversation. Pick by state: a SUSPENDED one is continued with agent_spawn using its resumeId (it keeps its full history and resumes where it stopped); a RUNNING one is steered with agent_guide, which delivers your directive at its next round boundary without starting a new run. Spawning a fresh agent for work an existing agent already carries discards that agent's context.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_agentList.toolDescription":
    "사용 가능한 LVIS agent profile 과 함께 이 대화의 기존 sub-agent 목록(resumeId·상태 포함)을 반환합니다. agent_spawn 전에 호출하세요: 기존 에이전트를 이어가라는 요청이면 새로 띄우지 말고 목록의 resumable 항목을 resumeId 를 지정한 agent_spawn 로 재개하세요. 앱을 재시작해도 이 대화에 남아 있는 sub-agent 는 여기에 나옵니다 — agent_status 는 살아 있는 실행만 보여줍니다.",
  "be_agentList.existingGuidance":
    "이 sub-agent 들은 이 대화에 이미 존재합니다. 상태에 따라 고르세요: 중단(suspended) 상태면 해당 resumeId 로 agent_spawn 을 호출해 전체 히스토리를 유지한 채 이어가고, 실행 중(running)이면 agent_guide 로 방향을 지시하세요 — 새 실행을 시작하지 않고 다음 round 경계에서 전달됩니다. 기존 에이전트가 이미 맡은 작업에 새 에이전트를 띄우면 그 에이전트의 컨텍스트를 버리게 됩니다.",
};
