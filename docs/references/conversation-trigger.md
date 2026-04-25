# Conversation Trigger — Proactive Brain HostApi

**Status**: P0 implemented · 2026-04-26
**Capability**: `conversation-trigger` (enforced)
**HostApi method**: `triggerConversation(spec)`
**Related**: [`plugin-tool-schema-design.md`](./plugin-tool-schema-design.md) §2.3 / §4 · `lvis-plugin-work-proactive` [DESIGN.md](https://github.com/lvis-project/lvis-plugin-work-proactive/blob/main/DESIGN.md) · `architecture.md` §6.3 (Source-aware Permissions)

## Why

LVIS 의 본질적 차별화 — 사용자가 먼저 묻기를 기다리지 않고, **신호를 본 plugin 이 ConversationLoop 를 능동적으로 발사**한다. 회의 요청 메일 도착 → "회의실 예약과 캘린더 등록을 도와드릴까요?" 채팅창에 *먼저* 띄움.

이 surface 는 **read-only brain plugin (proactive)** 만 사용한다. 일반 plugin 은 capability 를 부여받지 않으므로 호출 자체가 거부된다.

## Signature

```typescript
hostApi.triggerConversation(spec: ConversationTriggerSpec): Promise<ConversationTriggerResult>;

interface ConversationTriggerSpec {
  prompt: string;                                                    // templated, not raw
  source: string;                                                    // "proactive:<reason>"
  context?: Record<string, unknown>;
  visibility?: "silent" | "summary-only" | "user-visible";           // default: summary-only
  priority?: "low" | "normal" | "high";                              // default: normal
  dedupeKey?: string;
}

interface ConversationTriggerResult {
  accepted: boolean;
  reason?: "capability_denied" | "invalid_source" | "duplicate" | "loop_unavailable" | "disabled";
  source: string;
}
```

`spec.prompt` 는 caller 가 ConversationLoop 에 흘릴 templated 문자열 — 이게 그대로 user message 가 되어 분류·라우팅·LLM 호출까지 흘러간다.

## Safety contract — caller MUST honor

| 규칙 | 이유 |
|------|------|
| `prompt` 는 **templated 메시지만**. raw 제3자 컨텐츠 (메일 본문 / 첨부 / 외부 페이로드) 를 절대 그대로 inject 하지 말 것. **P0 한정**: tool 이 ID 로 후속 fetch 하려면 그 ID 를 `prompt` 에 직접 embed 해야 함 — `context` 는 현재 audit-only (P2 에서 per-turn metadata 로 plumbing 예정) | Prompt injection — 호스트는 본문 검증 못함. raw inject = jailbreak |
| `source` 는 반드시 `proactive:` 로 시작 | 소스-aware permission (§6.3) 정책 분리 |
| `dedupeKey` 는 같은 관찰이 반복 emit 될 수 있으면 (예: 동일 mailId 의 event 재방출) 항상 설정 | 사용자 짜증 / 토큰 폭주 |
| `visibility` / `priority` / `dedupeKey` — host 가 normalize 함 (`visibility="loud"` → `"summary-only"` 로 fallback, non-string `dedupeKey` → 무시, 128자 초과 truncate) | 잘못된 값이 audit 에 흘러들지 않게 |
| `triggerConversation()` 호출 자체에 await 의미 없음 (host fire-and-forget) | brain 이 ConversationLoop 결과까지 기다리면 다음 신호 처리 차단 |

## Host gate — 거부 케이스

| 거부 사유 | 조건 | 동작 |
|----------|------|------|
| `capability_denied` | manifest 에 `conversation-trigger` 없음 | 즉시 reject + audit (`trigger_conversation_denied reason=capability_denied`) |
| `invalid_source` | source 가 `proactive:` 로 시작 안 함 / 빈 prompt | reject + audit |
| `duplicate` | `dedupeKey` 가 5분 이내 매칭 | reject + audit |
| `loop_unavailable` | ConversationLoop 가 boot 순서상 아직 wire 안 됨 | reject + audit |

성공 시 fire-and-forget 으로 ConversationLoop.runTriggerTurn() 호출. 실패한 turn 은 loop 의 자체 audit 에 기록.

## Manifest 예시

```json
{
  "id": "work-proactive",
  "deployment": "bundled",
  "capabilities": [
    "conversation-trigger",
    "calendar-source",
    "mail-source"
  ],
  "tools": [],
  "eventSubscriptions": [
    "email.action.needed",
    "meeting.summary.created"
  ]
}
```

`tools: []` 권장 — brain plugin 은 LLM 에 노출되는 사용자 호출 tool 을 제공하지 않고, 자체 trigger 로만 동작.

## 사용 예 — 메일 회의 요청 detection

```typescript
context.hostApi.onEvent("email.action.needed", async (payload) => {
  const event = asRecord(payload);
  if (!event) return;

  // L1: deterministic filter (no LLM)
  const subject = String(event.subject ?? "");
  if (!/회의|미팅|meeting/i.test(subject)) return;

  // L4: trigger
  const res = await context.hostApi.triggerConversation({
    prompt: `회의 요청 이메일을 받았습니다. 발신자: ${sanitize(String(event.sender ?? ""))}, 캘린더 등록과 회의실 예약을 도와드릴까요?`,
    source: "proactive:meeting-detection",
    context: { emailId: event.id },           // body 는 절대 prompt 에 안 넣음
    visibility: "user-visible",
    priority: "normal",
    dedupeKey: `meeting-suggestion:${event.id}`,
  });

  if (!res.accepted) {
    context.log("proactive:trigger-rejected", { reason: res.reason });
  }
});
```

ConversationLoop 가 `prompt` 를 user turn 으로 받아 시스템 프롬프트 + 도구 셋과 함께 LLM 에 전달 — 이후 calendar / email tool 호출은 평소대로 §8 approval gate 거친다 (proactive 가 우회 X).

## Visibility — P0 / P2 분리

P0 는 **plumbing 만**:
- `visibility` 를 spec 에 받고 audit / runTriggerTurn 에 전달
- UI 분기 (silent vs user-visible 모달) 는 **P2 에서 구현**

P0 행동: 모든 visibility 가 동일하게 한 turn 을 끝까지 실행. `summary-only` / `silent` 라도 chat UI 에 흐름이 보일 수 있음. P2 에서 silent 는 audit-only, user-visible 는 모달, summary-only 는 1줄 알림으로 분기.

## 안전망 (P0 적용)

| 장치 | P0 상태 |
|------|------|
| Capability gate (`conversation-trigger`) | ✅ enforced |
| Source prefix (`proactive:`) | ✅ enforced |
| Dedupe (5분 TTL, per-pluginId) | ✅ enforced |
| ConversationLoop 미준비 시 reject | ✅ enforced |
| Audit (성공·실패 모두) | ✅ enforced |
| **LLM-side soft validation gate** — system prompt 에 "이 turn 은 proactive 가 발사함, 합당한지 먼저 판단하라" 가이드 자동 inject (`proactive:*` source 일 때만) | ✅ enforced (`SystemPromptBuilder` source id=4.6 — Proactive Origin Guidance) |
| Destructive op 의 hard gate | ✅ 기존 §8 ApprovalGate 가 source=`proactive:*` 도 동일 적용 |
| Visibility UI 분기 | ⏭️ P2 |
| Source-aware permission policy 통합 (§6.3) | ⏭️ P1 — `proactive:*` 정책 vocab 만 추가 예정 |
| Rate limit (per-plugin per-minute) | ⏭️ P3 — 운영 신호 발생 시 |
| **Hard LLM validation gate (별도 cheap-LLM 호출 전 단계)** | ⏭️ P2 옵션 B — soft gate 만으로 부족하다는 신호 발생 시 |

## 참고 구현

| 위치 | 역할 |
|------|----|
| `src/plugins/capabilities.ts` | `conversation-trigger` enforcement 등록 |
| `src/plugins/types.ts` | `PluginHostApi.triggerConversation` + Spec/Result 타입 |
| `src/engine/conversation-loop.ts` (`runTriggerTurn`) | host-side ConversationLoop 진입점. `SystemPromptBuilder.setOriginSource()` 로 LLM-side soft gate 활성화 후 turn 종료 시 항상 clear |
| `src/prompts/system-prompt-builder.ts` (id 4.6 — Proactive Origin Guidance) | `proactive:*` source 일 때만 "first 합당성 판단" 가이드 emit |
| `src/boot/steps/plugin-runtime.ts` (`createHostApi`) | gate 로직 + dedupe + audit |
| `src/boot/__tests__/proactive-trigger.test.ts` | gate / dedupe 단위 테스트 |
| `src/engine/__tests__/conversation-loop-trigger.test.ts` | runTriggerTurn 단위 + origin source set/clear |
| `src/prompts/__tests__/proactive-origin-guidance.test.ts` | guidance section 출력 / 비출력 / clear |
