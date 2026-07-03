// AUTO-GENERATED — i18n migration. Source: src/tools/agent-spawn.ts. Do not edit by hand.
export const en = {
  "be_agentSpawn.toolDescription":
    "Spawns a sub-agent to execute a small, isolated task. Fresh context separated from the parent conversation history; " +
    "only the specified sourceTools are available. The host assigns the sub-agent's round budget automatically from the agent's mode " +
    "(pick a fitting agentName for the work); you do not set it. " +
    "If agentName is specified, the ~/.lvis/agents/<name>.md or ~/.lvis/agents/<name>/AGENTS.md profile is merged in as the profile prompt. " +
    "Returns a summary text + tool call count. If the sub-agent hits its round budget before finishing, the result is marked incomplete " +
    "(with the partial output) so you can decide whether to continue it. " +
    "Do not use as a fallback path for directly calling a specific tool/plugin. If the target tool is visible, call it directly; if not, activate it via request_plugin.",
  "be_agentSpawn.propTitleDescription":
    "Short title for the sub-agent (shown in the UI card header). Required when agentName is not provided.",
  "be_agentSpawn.propAgentNameDescription":
    "Optional: agent profile name defined under ~/.lvis/agents/. When specified, uses that profile body and default sourceTools.",
  "be_agentSpawn.propInstructionsDescription":
    "Task for the sub-agent to perform — combined system+user prompt.",
  "be_agentSpawn.propSourceToolsDescription":
    "List of tool names to expose to the sub-agent. If omitted, the same tool set as the parent is used.",
  "be_agentSpawn.incompleteNotice":
    "The sub-agent reached its round budget before finishing — the summary above is PARTIAL, not a completed result. Review it and, if the task still needs work, spawn the sub-agent again to continue from where it left off (or take over the remaining steps yourself).",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_agentSpawn.toolDescription":
    "sub-agent 를 띄워 별도의 작은 작업을 실행합니다. 부모 대화 히스토리와 분리된 fresh 컨텍스트, " +
    "지정한 sourceTools 만 사용 가능. sub-agent 의 라운드 예산은 호스트가 agent 의 mode 로 자동 배정합니다 " +
    "(작업에 맞는 agentName 을 고르세요) — 직접 지정하지 않습니다. " +
    "agentName 을 지정하면 ~/.lvis/agents/<name>.md 또는 ~/.lvis/agents/<name>/AGENTS.md 프로필을 profile prompt 로 결합합니다. " +
    "결과로 요약 텍스트 + tool call 수 반환. sub-agent 가 완료 전에 라운드 예산에 도달하면 결과가 미완료로 표시되며 " +
    "(부분 출력 포함) 이어서 진행할지 판단할 수 있습니다. " +
    "특정 tool/plugin 을 직접 호출하라는 요청의 대체 경로로 사용하지 마세요. 요청 대상 도구가 현재 보이면 직접 호출하고, 보이지 않으면 request_plugin 으로 활성화하세요.",
  "be_agentSpawn.propTitleDescription":
    "sub-agent 의 짧은 제목 (UI 카드 헤더에 표시). agentName 이 없으면 필수입니다.",
  "be_agentSpawn.propAgentNameDescription":
    "선택: ~/.lvis/agents/ 에 정의된 agent profile 이름. 지정 시 해당 프로필 본문과 기본 sourceTools 를 사용합니다.",
  "be_agentSpawn.propInstructionsDescription":
    "sub-agent 가 수행할 작업 — system+user prompt 결합본.",
  "be_agentSpawn.propSourceToolsDescription":
    "sub-agent 에 노출할 tool 이름 목록. 생략 시 부모와 동일한 tool 셋.",
  "be_agentSpawn.incompleteNotice":
    "sub-agent 가 완료 전에 라운드 예산에 도달했습니다 — 위 요약은 완성된 결과가 아니라 부분 출력입니다. 검토 후 작업이 더 필요하면 sub-agent 를 다시 띄워 중단된 지점부터 이어가거나 (또는 남은 단계를 직접 처리하세요).",
};
