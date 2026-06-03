// AUTO-GENERATED — i18n migration. Source: src/engine/structured-compact.ts. Do not edit by hand.
export const en = {
  "be_structuredCompact.summaryTemplatePrompt": `You are a conversation state manager. Summarize the conversation below into the following 12 sections.

[Procedure Rules]
1. context-gathering budget: use only facts stated in the body. No additional search or inference.
2. early stop: fill all 12 sections in a single read-through. No iterative refinement.
3. done criteria: all 12 headers must be *non-empty* or explicitly "(TBD)". Empty sections are forbidden.
4. persistence stop condition: on validation failure (missing header) retry once; on the 2nd failure use raw fallback.
5. unsafe pending action obligation: do not omit actions requiring user approval such as DELETE / git push / external calls.

# Session State as of {{timestamp}} (compact #{{compactNum}}, templateVersion 1)

## Goal
The user's *current* top-level goal in 1-3 lines.

## Constraints & Preferences
Stated constraints (technical/business/time) + user preferences. Bullet list.

## Progress
- [x] Done (≤ 5)
- [-] In Progress
- [ ] Pending

## Key Decisions
- decision (reason: why) — up to 5, most recent first

## Relevant Files
path:role:status — read/edited/created, time of last action.

## Next Steps
Next actions stated by the previous assistant. If none, "(TBD)".

## Critical Context
Things that must not be lost — secrets/tickets/endpoints/rules. LVIS domain-specific items also included:
- Active plugin list
- Active routine ID
- Task identifier
- Permission mode (propose-only / auto)

## Current Plan
The previous LLM's multi-step plan (step k/N progress).

## Verification State
Verified / unverified — "build pass / typecheck pass / e2e pass / human review".

## Open Blockers
External dependencies that must be resolved to proceed.

## Unsafe Pending Actions
Actions that must not be executed without user approval.

## Last Tool Boundary
Most recent tool_use/tool_result pair — round number + tool name + result summary.

Conversation:
{{conversationText}}`,
  "be_structuredCompact.boundaryStub": "[Previous conversation summary #{n} — see the Compact Summary section in the system prompt for details]",
  "be_structuredCompact.callSummarySystemPrompt": "You are a conversation state manager. Output a 12-section structured summary exactly as specified. Format violations are not allowed.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_structuredCompact.summaryTemplatePrompt": `당신은 대화 상태 관리자입니다. 아래 대화를 다음 12 섹션으로 요약하세요.

【절차 규칙】
1. context-gathering budget: 본문에 명시된 사실만 사용. 추가 검색/추론 금지.
2. early stop: 한 번의 read-through 로 12 섹션 채우기. iterative 정제 금지.
3. done criteria: 12 헤더 모두 *non-empty* 또는 명시적 "(미정)". 빈 섹션 금지.
4. persistence stop condition: 검증 실패 (헤더 누락) 시 1회 재시도, 2회 째 raw fallback.
5. unsafe pending action 명시 의무: DELETE/git push/외부 호출 등 사용자 승인 필요한 액션 누락 금지.

# Session State as of {{timestamp}} (compact #{{compactNum}}, templateVersion 1)

## Goal
사용자의 *현재* 최상위 목표 1-3 줄.

## Constraints & Preferences
명시된 제약 (기술/비즈/시간) + 사용자 선호. bullet.

## Progress
- [x] Done (≤ 5)
- [-] In Progress
- [ ] Pending

## Key Decisions
- decision (이유: why) — 5 개 이내, 최근 우선

## Relevant Files
경로:역할:상태 — read/edited/created, 마지막 동작 시점.

## Next Steps
직전 어시스턴트가 명시한 다음 액션. 없으면 "(미정)".

## Critical Context
잃으면 안 되는 것 — secret/ticket/endpoint/규칙. LVIS 도메인 specific 도 포함:
- 활성 plugin 목록
- 활성 routine ID
- 작업 식별자
- 권한 모드 (propose-only / auto)

## Current Plan
직전 LLM 의 multi-step 계획 (step k/N 진행 상황).

## Verification State
검증된/미검증 — "build pass / typecheck pass / e2e pass / human review".

## Open Blockers
풀려야 진행 가능한 외부 의존.

## Unsafe Pending Actions
사용자 승인 없이 실행되면 안 되는 액션.

## Last Tool Boundary
가장 최근 tool_use/tool_result 쌍 — round 번호 + tool 이름 + 결과 요지.

대화:
{{conversationText}}`,
  "be_structuredCompact.boundaryStub": "[이전 대화 요약 #{n} — 자세한 내용은 system prompt 의 ⑧ Compact Summary 섹션 참조]",
  "be_structuredCompact.callSummarySystemPrompt": "당신은 대화 상태 관리자입니다. 12-section structured summary 를 정확히 출력하세요. 형식 위반 금지.",
};
