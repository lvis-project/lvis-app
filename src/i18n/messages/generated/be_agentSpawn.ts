// AUTO-GENERATED — i18n migration. Source: src/tools/agent-spawn.ts. Do not edit by hand.
export const en = {
  "be_agentSpawn.toolDescription":
    "Spawns a sub-agent to execute a small, isolated task. Fresh context separated from the parent conversation history; " +
    "only the specified sourceTools are available. The host assigns the sub-agent's round budget automatically from the agent's mode " +
    "(pick a fitting agentName for the work); you do not set it. " +
    "If agentName is specified, the ~/.lvis/agents/<name>.md or ~/.lvis/agents/<name>/AGENTS.md profile is merged in as the profile prompt. " +
    "Returns a summary text + tool call count. If the sub-agent hits its round budget before finishing, the result is marked incomplete " +
    "and carries a resumeId; call this tool again with that resumeId to continue the SAME sub-agent from where it stopped, and keep " +
    "resuming until the result comes back without the incomplete marker. An incomplete result is not an answer — never report one to " +
    "the user as if the sub-agent had finished. " +
    "Do not use as a fallback path for directly calling a specific tool/plugin. If the target tool is visible, call it directly; if not, activate it via request_plugin.",
  "be_agentSpawn.propTitleDescription":
    "Short title for the sub-agent (shown in the UI card header). Required when agentName is not provided.",
  "be_agentSpawn.propAgentNameDescription":
    "Optional: agent profile name defined under ~/.lvis/agents/. When specified, uses that profile body and default sourceTools.",
  "be_agentSpawn.propInstructionsDescription":
    "Task for the sub-agent to perform — combined system+user prompt.",
  "be_agentSpawn.propSourceToolsDescription":
    "List of tool names to expose to the sub-agent. If omitted, the same tool set as the parent is used.",
  "be_agentSpawn.propResumeIdDescription":
    "Optional: resume a previously-spawned sub-agent by its resumeId (returned in an incomplete result). When set, the sub-agent's history is re-hydrated and continued with instructions as the follow-up prompt; its tool scope stays frozen to the original spawn (not re-granted). Omit to start a fresh sub-agent.",
  "be_agentSpawn.incompleteNotice":
    "This run is NOT finished. The sub-agent hit its round budget mid-task, so the summary above is a partial snapshot, not an answer — do not report it to the user as a result. Call agent_spawn again with resumeId=\"{resumeId}\" and instructions naming what still needs doing; the sub-agent keeps its history and continues from exactly where it stopped. Repeat until it returns without this notice. If you deliberately stop resuming, say so explicitly and tell the user the work was left incomplete.",
  "be_agentSpawn.freshSpawnFailedGuidance":
    "This sub-agent died before finishing and CANNOT be resumed — it never suspended, so there is no point to continue from. Do not immediately spawn the same task again: an identical retry that hits the same condition just burns another agent. Read the error first. If the cause looks transient (provider hiccup, timeout), one retry is reasonable. If it does not, change something — narrow the task, adjust sourceTools, or do the work yourself — and tell the user this agent was lost.",
  "be_agentSpawn.freshSpawnRejectedGuidance":
    "This sub-agent was REJECTED by the provider, not interrupted — the same request will be refused the same way every time. It cannot be resumed and retrying it unchanged cannot succeed. Change the request before trying again: narrow sourceTools (a tool schema the provider cannot compile is the usual cause), simplify the instructions, or do the work without a sub-agent. Tell the user why this agent could not run.",
  "be_agentSpawn.resumeRetryGuidance":
    "The sub-agent is STILL RESUMABLE — this failure did not consume its history. Retry agent_spawn with the SAME resumeId (transient provider errors usually clear on retry). Do NOT spawn a fresh agent for this work: that discards everything the suspended sub-agent already established.",
  "be_agentSpawn.resumeExhaustedGuidance":
    "This sub-agent's cumulative round ceiling is spent and it can NEVER be resumed again. Do not retry this resumeId. Read its last summary, finish the remaining steps yourself or in a NEW narrower sub-agent, and tell the user the original agent was cut short.",
  "be_agentSpawn.resumeInvalidGuidance":
    "This resumeId can NEVER be resumed — the rejection is structural (wrong task state, ownership, or persisted metadata), so retrying the SAME resumeId will fail identically every time. Do NOT retry it. If the work is still needed, start a NEW sub-agent for it, and tell the user the original agent could not be continued.",
  "be_agentSpawn.resumeProviderRejectedGuidance":
    "The provider REFUSED this request itself — not a transient outage. It validates the request before generating, and it will refuse an identical request identically every time, so retrying the SAME resumeId is a loop with no exit. The sub-agent's history is intact and it stays resumable, but only after something about the request changes: switch the model or provider, or continue the work in a NEW sub-agent with a narrower tool scope. Report the provider error text to the user rather than retrying silently.",
  "be_agentSpawn.emptySummaryFallback":
    "Task state: {taskState} — the sub-agent produced no summary. Resume it with agent_spawn(resumeId: \"{resumeId}\") to see the details.",
  "be_agentSpawn.statusToolDescription":
    "Inspect active or recent sub-agent runs. Pass spawnId or childSessionId as id; omit id to list all tracked runs. Live runs only: after an app restart, sub-agents persisted from this conversation are listed by agent_list, not here.",
  "be_agentSpawn.statusRestoredHint":
    "No run is live in this process, but {count} sub-agent(s) from this conversation survived a restart. An empty run list does NOT mean their work finished — call agent_list to see them with their resumeId and state.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_agentSpawn.toolDescription":
    "sub-agent 를 띄워 별도의 작은 작업을 실행합니다. 부모 대화 히스토리와 분리된 fresh 컨텍스트, " +
    "지정한 sourceTools 만 사용 가능. sub-agent 의 라운드 예산은 호스트가 agent 의 mode 로 자동 배정합니다 " +
    "(작업에 맞는 agentName 을 고르세요) — 직접 지정하지 않습니다. " +
    "agentName 을 지정하면 ~/.lvis/agents/<name>.md 또는 ~/.lvis/agents/<name>/AGENTS.md 프로필을 profile prompt 로 결합합니다. " +
    "결과로 요약 텍스트 + tool call 수 반환. sub-agent 가 완료 전에 라운드 예산에 도달하면 결과가 미완료로 표시되고 resumeId 가 함께 반환됩니다. " +
    "그 resumeId 로 이 도구를 다시 호출해 같은 sub-agent 를 중단 지점부터 이어가고, 미완료 표시가 사라질 때까지 재개를 반복하세요. " +
    "미완료 결과는 답이 아니므로 sub-agent 가 끝난 것처럼 사용자에게 보고하면 안 됩니다. " +
    "특정 tool/plugin 을 직접 호출하라는 요청의 대체 경로로 사용하지 마세요. 요청 대상 도구가 현재 보이면 직접 호출하고, 보이지 않으면 request_plugin 으로 활성화하세요.",
  "be_agentSpawn.propTitleDescription":
    "sub-agent 의 짧은 제목 (UI 카드 헤더에 표시). agentName 이 없으면 필수입니다.",
  "be_agentSpawn.propAgentNameDescription":
    "선택: ~/.lvis/agents/ 에 정의된 agent profile 이름. 지정 시 해당 프로필 본문과 기본 sourceTools 를 사용합니다.",
  "be_agentSpawn.propInstructionsDescription":
    "sub-agent 가 수행할 작업 — system+user prompt 결합본.",
  "be_agentSpawn.propSourceToolsDescription":
    "sub-agent 에 노출할 tool 이름 목록. 생략 시 부모와 동일한 tool 셋.",
  "be_agentSpawn.propResumeIdDescription":
    "선택: 이전에 띄운 sub-agent 를 resumeId (미완료 결과에 반환됨) 로 이어서 실행합니다. 지정 시 sub-agent 히스토리를 재수화하고 instructions 를 후속 프롬프트로 이어갑니다. tool 범위는 최초 spawn 시점으로 고정되어 재부여되지 않습니다. 생략하면 새 sub-agent 를 시작합니다.",
  "be_agentSpawn.incompleteNotice":
    "이 실행은 끝나지 않았습니다. sub-agent 가 작업 도중 라운드 예산에 도달했으므로 위 요약은 답이 아니라 중간 스냅샷입니다 — 사용자에게 결과로 보고하지 마세요. agent_spawn 을 resumeId=\"{resumeId}\" 와 남은 작업을 명시한 instructions 로 다시 호출하세요. sub-agent 는 히스토리를 유지한 채 중단된 지점부터 정확히 이어갑니다. 이 안내가 사라질 때까지 반복하세요. 의도적으로 재개를 중단한다면 그 사실을 명시하고 작업이 미완료로 남았음을 사용자에게 알리세요.",
  "be_agentSpawn.freshSpawnFailedGuidance":
    "이 sub-agent 는 완료 전에 죽었고 **재개할 수 없습니다** — 중단(suspend) 한 적이 없어 이어갈 지점 자체가 없습니다. 같은 작업을 곧바로 다시 띄우지 마세요: 동일 조건에 걸리는 재시도는 에이전트만 하나 더 소모합니다. 먼저 오류를 읽으세요. 원인이 일시적(프로바이더 오류, 타임아웃)으로 보이면 한 번 재시도는 합리적입니다. 그렇지 않다면 무언가를 바꾸세요 — 작업 범위를 좁히거나, sourceTools 를 조정하거나, 직접 수행하고 — 이 에이전트가 유실됐음을 사용자에게 알리세요.",
  "be_agentSpawn.freshSpawnRejectedGuidance":
    "이 sub-agent 는 중단된 게 아니라 프로바이더가 **거부**했습니다 — 같은 요청은 매번 같은 방식으로 거부됩니다. 재개할 수 없고, 바꾸지 않은 재시도는 성공할 수 없습니다. 다시 시도하기 전에 요청을 바꾸세요: sourceTools 를 좁히거나(프로바이더가 컴파일하지 못하는 tool 스키마가 흔한 원인), instructions 를 단순화하거나, sub-agent 없이 처리하세요. 이 에이전트가 왜 실행되지 못했는지 사용자에게 알리세요.",
  "be_agentSpawn.resumeRetryGuidance":
    "이 sub-agent 는 여전히 재개 가능합니다 — 이번 실패로 히스토리가 소실되지 않았습니다. 같은 resumeId 로 agent_spawn 을 재시도하세요 (일시적 provider 오류는 대개 재시도로 해소됩니다). 이 작업을 위해 새 에이전트를 띄우지 마세요: 중단된 sub-agent 가 이미 쌓은 것을 전부 버리게 됩니다.",
  "be_agentSpawn.resumeExhaustedGuidance":
    "이 sub-agent 는 누적 라운드 상한을 소진해 다시는 재개할 수 없습니다. 이 resumeId 를 재시도하지 마세요. 마지막 요약을 읽고 남은 단계를 직접 또는 더 좁은 새 sub-agent 로 마무리하고, 원래 에이전트가 중단됐음을 사용자에게 알리세요.",
  "be_agentSpawn.resumeInvalidGuidance":
    "이 resumeId 는 다시는 재개할 수 없습니다 — 거부 사유가 구조적(task 상태/소유권/영속 메타데이터 불일치)이므로 같은 resumeId 재시도는 매번 동일하게 실패합니다. 재시도하지 마세요. 작업이 여전히 필요하면 새 sub-agent 로 시작하고, 원래 에이전트를 이어갈 수 없었음을 사용자에게 알리세요.",
  "be_agentSpawn.resumeProviderRejectedGuidance":
    "이 요청 자체를 provider 가 거부했습니다 — 일시적 장애가 아닙니다. provider 는 생성 전에 요청을 검증하며 동일한 요청은 매번 동일하게 거부하므로, 같은 resumeId 재시도는 빠져나올 수 없는 루프입니다. sub-agent 히스토리는 온전하고 여전히 재개 가능하지만, 요청이 달라진 뒤에만 가능합니다: 모델이나 provider 를 바꾸거나, 더 좁은 tool 범위의 새 sub-agent 로 작업을 이어가세요. 조용히 재시도하지 말고 provider 오류 원문을 사용자에게 보고하세요.",
  "be_agentSpawn.emptySummaryFallback":
    "작업 상태: {taskState} — 서브에이전트가 요약을 남기지 않았습니다. agent_spawn(resumeId: \"{resumeId}\") 로 재개해 상세를 확인하세요.",
  "be_agentSpawn.statusToolDescription":
    "활성 또는 최근 sub-agent 실행을 조회합니다. id 로 spawnId 또는 childSessionId 를 넘기고, 생략하면 추적 중인 실행을 모두 나열합니다. 여기에는 살아 있는 실행만 나옵니다 — 앱 재시작 후 이 대화에 남아 있는 sub-agent 는 agent_list 가 보여줍니다.",
  "be_agentSpawn.statusRestoredHint":
    "이 프로세스에는 살아 있는 run 이 없지만, 이 대화의 sub-agent {count} 개가 재시작 후에도 남아 있습니다. run 목록이 비었다고 해서 그 작업이 끝난 것이 아닙니다 — agent_list 를 호출하면 resumeId 와 상태까지 확인할 수 있습니다.",
};
