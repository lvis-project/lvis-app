// AUTO-GENERATED — i18n migration. Source: src/tools/agent-spawn.ts. Do not edit by hand.
export const en = {
  "be_agentSpawn.toolDescription":
    "Spawns a sub-agent to execute a small, isolated task. Fresh context separated from the parent conversation history; " +
    "only the specified sourceTools are available. maxTurns (default 30, cap 30) — specify explicitly based on your own assessment of task complexity: " +
    "single lookup/summarization 5-10, standard multi-step work 15-20, deep code exploration/multi-file analysis/complex debugging 25-30. " +
    "If agentName is specified, the ~/.lvis/agents/<name>.md or ~/.lvis/agents/<name>/AGENTS.md profile is merged in as the profile prompt. " +
    "Returns a summary text + tool call count. " +
    "Do not use as a fallback path for directly calling a specific tool/plugin. If the target tool is visible, call it directly; if not, activate it via request_plugin.",
  "be_agentSpawn.propTitleDescription":
    "Short title for the sub-agent (shown in the UI card header). Required when agentName is not provided.",
  "be_agentSpawn.propAgentNameDescription":
    "Optional: agent profile name defined under ~/.lvis/agents/. When specified, uses that profile body and default sourceTools.",
  "be_agentSpawn.propInstructionsDescription":
    "Task for the sub-agent to perform — combined system+user prompt.",
  "be_agentSpawn.propSourceToolsDescription":
    "List of tool names to expose to the sub-agent. If omitted, the same tool set as the parent is used.",
  "be_agentSpawn.propMaxTurnsDescription":
    "Maximum number of assistant rounds (cap 30). Default 30. Simple lookup 5-10 · standard 15-20 · complex multi-step 25-30. LLM decides directly based on task complexity.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_agentSpawn.toolDescription":
    "sub-agent 를 띄워 별도의 작은 작업을 실행합니다. 부모 대화 히스토리와 분리된 fresh 컨텍스트, " +
    "지정한 sourceTools 만 사용 가능. maxTurns (기본 30, 상한 30) — task 복잡도를 직접 판단해서 명시하세요: " +
    "단일 lookup/요약은 5-10, 표준 multi-step 작업은 15-20, 깊은 코드 탐색·다중 파일 분석·복합 디버깅은 25-30. " +
    "agentName 을 지정하면 ~/.lvis/agents/<name>.md 또는 ~/.lvis/agents/<name>/AGENTS.md 프로필을 profile prompt 로 결합합니다. " +
    "결과로 요약 텍스트 + tool call 수 반환. " +
    "특정 tool/plugin 을 직접 호출하라는 요청의 대체 경로로 사용하지 마세요. 요청 대상 도구가 현재 보이면 직접 호출하고, 보이지 않으면 request_plugin 으로 활성화하세요.",
  "be_agentSpawn.propTitleDescription":
    "sub-agent 의 짧은 제목 (UI 카드 헤더에 표시). agentName 이 없으면 필수입니다.",
  "be_agentSpawn.propAgentNameDescription":
    "선택: ~/.lvis/agents/ 에 정의된 agent profile 이름. 지정 시 해당 프로필 본문과 기본 sourceTools 를 사용합니다.",
  "be_agentSpawn.propInstructionsDescription":
    "sub-agent 가 수행할 작업 — system+user prompt 결합본.",
  "be_agentSpawn.propSourceToolsDescription":
    "sub-agent 에 노출할 tool 이름 목록. 생략 시 부모와 동일한 tool 셋.",
  "be_agentSpawn.propMaxTurnsDescription":
    "최대 어시스턴트 라운드 수 (상한 30). 기본 30. 간단 lookup 5-10 · 표준 15-20 · 복잡 multi-step 25-30. LLM 이 task 복잡도로 직접 판단.",
};
