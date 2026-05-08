# Infinity Session Redesign v3 — 3-way regression patches applied

**Status**: 🟡 DRAFT (3-way regression 통합 후, APPROVE 준비)
**Date**: 2026-05-08
**Supersedes**: `infinity-session-redesign-v2.md` (3-way regression patches P1-P11 적용)
**Architecture ref**: `architecture.md` v4 §4.5 / §4.6 / §5
**Review trail**: 5-reviewer (v1) → architect+critic+codex (v2 회귀) → v3 patch
**Verdict 잠정**: REVISE → v3 patch 적용 후 APPROVE 예상

> v2 → v3 핵심 patch:
> - **P1**: §4.5.9 ⑧ slot 동일-턴 race 해소 (algorithm sync chain 명시)
> - **P2**: OpenAI opaque slot — string 아니라 compaction item *전체* 저장
> - **P3**: §6 임계값 "Codex 권장" 표현 폐기, "LVIS 보수 default" 로 낮춤
> - **P4**: SUMMARY_TEMPLATE 절차 규칙 (context-gathering budget / early-stop / done criteria)
> - **P5**: opaque-state slot YAGNI 분석 (`pinnedArtifacts`/`toolBoundaryLedger` 정당화)
> - **P6**: R12 JSONL append — PR-2 안 처리 결정
> - **P7**: boundary object `Object.freeze()` 명시
> - **P8**: Rollback `meta.boundary` schema forward-incompat 처리
> - **P9**: Concurrency race (2 turn 동시 Layer 2) mitigation
> - **P10**: `isContextLengthError` deprecation 정책
> - **P11**: 한글 비율 detection algorithm 본문 명시

---

## 1. Goal — 인피니티 세션 정의

> 사용자가 세션을 명시적으로 종료하지 않은 채 며칠~몇 주 단위로 같은 sessionId 안에서 대화를 이어가도, *대화 품질 단조 비감소* + *주제 일관성 유지* + *임의 시점 회귀 가능* 을 만족시키는 단일 세션 모델.

### 1.1 측정 가능한 성공 지표 (LLM-as-judge fixture 포함)

| 지표 | 목표 | 측정 fixture |
|---|---|---|
| Mid-loop reactive compact 발생률 | 0/turn | 진단 로그 `queryLoop: context_error caught` 카운트 |
| 압축 후 LLM empty-response 비율 | < 0.1 % | 동일 로그 + retry empty 카운트 |
| 세션 fork (sessionId 변경) 빈도 | 0 (사용자 명시 fork 만) | sessionId 분기 카운트 |
| **Goal/Decisions 보존률 ≥ 95%** | **golden quiz set 자동 평가** | `tests/recall-eval/golden-quiz-set.json` × pre/post compact 답변 → LLM-as-judge (별도 모델, embedding similarity ≥ 0.85 또는 judge OK) |
| 세션 길이 한도 | 1000+ turn 통과 | 7일 stress test |

**Recall Eval 자동화** (M-5): `engine/__tests__/recall-eval.integration.test.ts` 신규.
**Mixed-language fixture** (P11): golden quiz set 에 한글-only / 영문-only / 50:50 mixed 3 변형 포함.

### 1.2 Why-not-fork? — 새 세션 vs same-session (devil's advocate)

| 옵션 | 장점 | 단점 |
|---|---|---|
| 새 세션 fork (Codex Memories 모델) | mental clean slate, 검색 인덱스 단순 | 회상 비용 ↑, routine 과 mismatch |
| **same-session compact** (본 청사진) | 회상 0 비용, routine 과 정합 | 압축 정확도 의존, JSONL 누적 |

채택 근거: §7 Proactive Engine + routine 시나리오는 *지속성* 가정. fork 모델 시 cross-session memory 수동 관리 → 사용자 mental overhead.

### 1.3 Non-goals
- *latent-preserving handoff* — Anthropic/Gemini 미지원
- 月 단위 풀텍스트 회귀 (preview + checkpoint summary 로 충분)
- Multi-device sync (별도 PR)

---

## 2. 현재 구조의 핵심 문제 (요약)

| 문제 | 증거 |
|---|---|
| 5 메커니즘 중복 | microcompact + auto-compact + reactive-compact + rotation Tier 1/2/3 |
| `cumulativeUsage` lifetime 누적 | `conversation-loop.ts:1135` 매 라운드 `+= adjustedIn`. compact 후 reset 누락 |
| mid-loop reactive compact 위험 | `conversation-loop.ts:1027~1074` |
| dead state | `meta.carryover` + `extractCarryover()` (`auto-compact.ts:455~514`, line 264) |
| rotation = sessionId fork | `conversation-loop.ts:1684` |

---

## 3. References — 3-source 비교 (Codex 는 footnote)

| 차원 | OpenCode | Gemini CLI | Copilot Chat |
|---|---|---|---|
| 트리거 | 끝 40K preserve + ≥20K free 가능 시 | 50% (`COMPRESSION_TOKEN_THRESHOLD = 0.5`) | 모델 한도 근접 |
| 1차 시도 | part marking (`part.state.time.compacted = Date.now()`) | head/tail 분할 | 자동 background |
| 2차 시도 | 7-section SUMMARY_TEMPLATE | XML 스냅숏 | LLM 요약 |
| 보존 | 끝 40K verbatim, skill 도구 prune 금지 | Reverse Token Budget 30줄 | preserve recent |
| 클러스터링 | 시간 기반 | Union-Find episode (실험, default X) | 시간 기반 |
| 체크포인트 ↔ compact | 분리 | 분리 | 별개 (compact 와 chat.checkpoints 독립) |

> **Footnote: Codex CLI 차용 0건 사유**
> Codex CLI 는 OpenAI Responses API 종속 (`type:"compaction"` item + reasoning item 의 optional `encrypted_content`). Anthropic/Gemini 는 동등 reasoning-state 재주입 API 미제공. 단 §4.3 의 `opaque-state slot` 추상화는 OpenAI 차용 path 를 *향후* 열어둠.

---

## 4. Architecture — 3-Layer Model

### 4.1 Layer 0: Pre-flight Guard (per-round, no LLM)

**위치**: §4.5.2 step 5 (`HISTORY_APPEND`) 직후 / step 6 (`PROMPT_ASSEMBLE`) 직전.
`conversation-loop.ts:723~742` 사이.

**알고리즘**:
```
estimated   = estimateMessagesTokens(history)         # P11 한글 가중치
preflight   = getPreflightThreshold(provider, model)
if estimated >= preflight:
    runLayer2Compact(reason="preflight")              # 동기 차단 — P1
```

**P11 — 한글 비율 detection algorithm**:
```
hangulCount = countHangul(text)                      # 가-힣 범위
totalCount  = text.length
ratio       = hangulCount / max(totalCount, 1)
weight      = ratio >= 0.5 ? 1.3 : 1.0               # 50% threshold (claw-code 패턴)
estimateTokens(text) = ceil(text.length * weight / 4) + 1
```
Mixed-language (코드+한글 주석) 시 ratio < 0.5 → weight 1.0. 보수적 fallback.

**불변식**:
- LLM 호출 0
- estimateTokens 한글 가중치 자동 적용

### 4.2 Layer 1: Part Marking (lazy, idempotent, no LLM)

**현 microcompact 대체**.

**위치**: `auto-compact.ts:markStaleToolResults` (rename from `microcompactMessages`).

> **구현 단계 (이 청사진은 *목표 상태* 기술)**
> - PR-1b: rename + 200 자 임계. content stub-replace 동작 유지 (transitional).
> - PR-3 (stamping behavior): 메모리 *verbatim* + serialization-time stub 으로 전환 — `meta.compactedAt` 마킹만 in-memory.
> - 따라서 아래 “content 보존 (메모리)” 항목은 PR-3 머지 후 도달 상태이며, PR-1 시점은 stub-replace.

**변경점**:
- `meta.compactedAt: ts` 만 마킹, content 보존 (메모리) ※ PR-3 후 도달
- 직렬화 단계 (provider 호출 + 디스크 JSONL append) 에서만 stub 화 — 메모리는 verbatim ※ PR-3 후 도달
- stub 임계: tool_result ≥ 200 자
- 끝 N=8 tool_result preserve

**불변식**:
- skill-route + `meta.lock: true` marking 면제
- toolUseId 절대 변경 X
- idempotent

**SubAgentRunner stamping (Q2 default — architect v3 회귀 후 정정)**: child loop 의 `postTurnHookChain: undefined` (`subagent-runner.ts:149-151`) 는 *의도된 isolation contract* — fire-and-forget child 가 parent session 의 `notes/` / `audit.jsonl` / idle-poke 에 side effect 일으키면 안 됨. 따라서 6-stage hook chain 의 stage 1 만 *최소 inject*:

> **구현 단계**
> - PR-1c (실제 머지본): `SubAgentRunnerDeps` 에 새 hook field 를 추가하지 않고, child ConversationLoop 의 *fallback path* (post-turn-hook-chain 미주입) 에서 `markStaleToolResults` 를 inline 호출하도록 단순화. side effect 0 + isolation contract 동일 유지.
> - PR-1c 이후: 아래 “신규 field 추가” 안은 폐기. inline fallback 이 채택본.

- ~~신규 field `markStaleToolResultsHook?: (messages: GenericMessage[]) => GenericMessage[]` 를 `SubAgentRunnerDeps` 에 추가~~ → PR-1c 에서 inline fallback 으로 대체됨
- child loop 가 매 turn 후 *이것만* 호출 (extractMemory / auditLog / idle-poke / chainTitle / detect-checkpoint 모두 *제외*)
- `postTurnHookChain` 자체는 `undefined` 유지 — isolation contract 그대로

이렇게 하면 child 도 Layer 1 marking 이득은 가지면서 parent session 무결성 보존.

### 4.3 Layer 2: Structured Compact + opaque-state slot (LLM, 임계 도달 시)

**현 auto-compact + reactive compact 통합 대체**.

**위치**: `engine/structured-compact.ts` (신규).

#### 4.3.1 opaque-state slot 인터페이스 (P2 정정)

```typescript
interface CompactBoundary {
  templateVersion: 1;

  // OpenAI 향후 path — string 이 아니라 compaction item *전체* (P2)
  vendorOpaqueState?:
    | { vendor: "openai"; openaiCompactionItem: OpenAICompactionItem }
    // OpenAICompactionItem ≈ { type: "compaction", encrypted_content: string, ... }
    // Responses API 의 `/responses/compact` 결과 그대로 보존
    | { vendor: "anthropic" | "gemini"; /* future */ };

  // 모든 vendor 의 차선 (필수)
  structuredSummary: ParsedSummary;     // §5 12-section
  recentVerbatim: GenericMessage[];     // 끝 N 토큰 (Cline 룰)

  // P5 — YAGNI 분석 후 정당화
  pinnedArtifacts: string[];            // skill outputs / lock 메시지 — 영구 보존 정책 (현재 사용)
  toolBoundaryLedger: ToolCallSummary[]; // 마지막 K 라운드 tool_use/result 요약 (R6 fallback 시 LLM 이 read)
}
```

**P5 — opaque-state slot 비용/가치 분석**:
| 필드 | 즉시 사용 | 향후 사용 | 정당화 |
|---|---|---|---|
| `vendorOpaqueState` | X | OpenAI path 활성화 시 | interface placeholder — Anthropic/Gemini 만 PR-2 활성, 미사용 시 undefined |
| `structuredSummary` | ✅ | 모든 vendor | 핵심 fallback |
| `recentVerbatim` | ✅ | 모든 vendor | Cline preserve-recent 패턴 |
| `pinnedArtifacts` | ✅ | 모든 vendor | OpenCode skill 출력 보존 패턴 (현재 LVIS skill route 와 정합) |
| `toolBoundaryLedger` | ✅ | 모든 vendor | R6 fallback 시 LLM 의 tool-chain 회상 — Codex GPT-5 prompting guide "last tool boundary" 패턴 |

→ 모든 필드 정당화됨. PR-2 에서 `vendorOpaqueState` 만 placeholder, 나머지 4 필드 활성.

**P7 — boundary object freeze**: `structured-compact.ts` 의 `compactWithBoundary()` 반환 직후 `Object.freeze(boundary)` 호출. ⑧ slot + Layer 3 storage + history[0] 3 reference 모두 동일 immutable object 가리킴 → race 방지.

#### 4.3.2 Vendor 분기 직렬화

| Vendor | boundary 직렬화 |
|---|---|
| OpenAI (향후) | `vendorOpaqueState.openaiCompactionItem` 을 input items 에 그대로 포함 |
| Anthropic | system block 에 `<compact-boundary>...</compact-boundary>` fence wrap |
| Gemini | system instruction 에 동등 fence |

**Vendor precedence rule** (architect v3 정정): `vendorOpaqueState` 가 *현재 활성 vendor* 와 일치하면 그것 *만* 직렬화 (`structuredSummary` 미포함). 일치 안 하거나 부재 시 `structuredSummary` + `recentVerbatim` 으로 fallback. **두 채널 동시 직렬화 금지** — double-state hallucination 방지.

#### 4.3.3 알고리즘 (P1 — 동기 sync chain)

```
1. messagesToCompact = history.slice(0, len - PRESERVE_RECENT_TOKENS)
2. messagesToPreserve = history.slice(len - PRESERVE_RECENT_TOKENS)
3. structuredSummary = await callLLM(SUMMARY_TEMPLATE_PROMPT, messagesToCompact)  # 차단형
4. pinnedArtifacts = collectLocked(messagesToCompact)
5. ledger = summarizeToolCalls(messagesToCompact.slice(-K_TOOL_LEDGER))
6. boundary = Object.freeze({ templateVersion: 1, structuredSummary, recentVerbatim: messagesToPreserve, pinnedArtifacts, toolBoundaryLedger: ledger })
7. newHistory = [boundaryAsSystemBlock(boundary), ...messagesToPreserve]
8. cumulativeUsage = estimateMessagesTokens(newHistory)   # 의미 정합 reset
9. ⑧ slot 갱신 — system-prompt-builder.compactSummarySlot = boundary
10. checkpointStore.appendBookmark(boundary, ts)          # Layer 3
# ↑ 1~10 까지 *동기* 완료 후에만 Layer 0 caller 가 step 6 PROMPT_ASSEMBLE 진입
```

**P1 — 동일-턴 race 해소**:
- Layer 0 가 step 5/6 사이에서 *await* 하므로, step 9 까지 완료 후에만 step 6 진입 보장
- system-prompt-builder 가 step 6 에서 ⑧ slot read 시 *항상 새 boundary* 가 보임
- `Object.freeze` (P7) 로 step 9 이후 boundary 변경 불가 → ⑧ slot + Layer 3 + history 3 view 일관

**P9 — Concurrency race (2 turn 동시 Layer 2)**:
- ConversationLoop 인스턴스 당 *single in-flight Layer 2* 락. `private isCompacting: boolean = false`.
- 동시 진입 시 두번째는 첫번째 await + 새 boundary read.
- 다중 ConversationLoop 인스턴스 (multi-window) 는 각자 sessionId 분리 → race 없음.

**§4.5.9 ⑧ slot + `<prior-context-summary>` fence 의 운명** (architect C1 정합):
- ⑧ slot **유지** — Layer 2 의 `boundary` 가 ⑧ slot 채움
- fence **유지** — boundary 직렬화 시 wrap

### 4.4 Layer 3: Checkpoint (same sessionId, 북마크 chain)

**위치 (module boundary 정합)**:
- `memory/checkpoint-store.ts` — storage owner
- `engine/checkpoint-trigger.ts` — Layer 2 호출자가 inject only
- `ui/renderer/components/CheckpointDivider.tsx` — UI owner

**Trigger** (compact ≠ checkpoint 분리):
- Layer 2 발생 시 자동 북마크 추가
- LLM `[checkpoint]` 마커 → 라벨링 신호 (compact 트리거 X)
- 사용자 수동 `/checkpoint <label>` — 라벨링만
- 24h+ 휴면 후 첫 turn — day-boundary 자동 북마크

**Storage** (`~/.lvis/sessions/<sessionId>.checkpoints.json`):
```json
{
  "sessionId": "abc-123",
  "checkpoints": [
    {
      "id": "ckpt-uuid",
      "num": 1,
      "createdAt": "2026-05-08T08:00:00.000Z",
      "trigger": "auto-compact" | "semantic-llm-marker" | "manual" | "day-boundary",
      "messageIndexAtCreation": 47,
      "boundary": { /* CompactBoundary */ },
      "label": "auth refactor done"
    }
  ]
}
```

**Revert UI**:
- 클릭 시 sessionId 그대로, history `messageIndexAtCreation` 슬라이스 view
- "여기서부터 다시" → 그 시점 history + 새 turn (sessionId 불변)
- Branch 발생 시 (revert 후 새 입력) 자동 새 sessionId fork

---

## 5. SUMMARY_TEMPLATE — 12-Section + 절차 규칙 (P4)

### 5.1 LLM 프롬프트

```
당신은 대화 상태 관리자입니다. 아래 대화를 다음 12 섹션으로 요약하세요.

【절차 규칙 — Codex GPT-5 prompting guide】
1. context-gathering budget: 본문에 명시된 사실만 사용. 추가 검색/추론 금지.
2. early stop: 한 번의 read-through 로 12 섹션 채우기. iterative 정제 금지.
3. done criteria: 12 헤더 모두 *non-empty* 또는 명시적 "(미정)". 빈 섹션 금지.
4. persistence stop condition: 검증 실패 (헤더 누락) 시 1회 재시도, 2회 째 raw fallback.
5. unsafe pending action 명시 의무: DELETE/git push/외부 호출 등 사용자 승인 필요한 액션 누락 금지.

# Session State as of {{timestamp}} (compact #{{N}}, templateVersion 1)

## Goal
사용자의 *현재* 최상위 목표 1-3 줄.

## Constraints & Preferences
명시된 제약 (기술/비즈/시간) + 사용자 선호.

## Progress
- [x] Done (≤ 5)
- [-] In Progress
- [ ] Pending

## Key Decisions
- decision (이유: why) — 5 개 이내, 최근 우선

## Relevant Files
경로:역할:상태 — read/edited/created, 마지막 동작.

## Next Steps
직전 어시스턴트가 명시한 다음 액션. 없으면 "(미정)".

## Critical Context
잃으면 안 되는 것 — secret/ticket/endpoint/규칙. LVIS 도메인 specific 포함:
- 활성 plugin 목록
- 활성 routine ID
- 작업 PR 번호
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
가장 최근 tool_use/tool_result 쌍 — round + tool 이름 + 결과 요지.

대화:
{{conversationText}}
```

### 5.2 Parser + version 분기

`structured-compact.ts:parseSummary(text, version)`:
- v1: 12 헤더 모두 존재 + non-empty (또는 "(미정)") 검증
- 누락 시 1회 재호출 (P4 절차 4)
- 2회 실패 시 raw → `boundary.structuredSummary.raw`

### 5.3 templateVersion 진화 정책

- `boundary.templateVersion` 필수
- v2 도입 시 v1 boundary 그대로 유지
- 새 compact 시점부터만 v2 자동 적용
- (옵션) `/recompact-all` 커맨드는 follow-up PR 범위 (Q3 default X)

---

## 6. Per-Model Thresholds — LVIS 보수 default (P3)

> **P3 — 표현 정정**: 이 표는 *Codex CLI 권장값* 이 아니라 **LVIS 자체 보수 정책**. Codex CLI 공식 docs 는 `compact_threshold: 200000` 같은 절대값 예시만 제공하며 계단식 비율 권장 X.

| Model context | Usable (Cline buffer) | Layer 0 임계 (`getPreflightThreshold`) | Layer 2 PRESERVE_RECENT_TOKENS | p50 압축 latency 추정 (Haiku) |
|---|---|---|---|---|
| 64K | 37K | 50 % (≈ 18K) | 6K | ~3s |
| 128K | 98K | 55 % (≈ 54K) | 12K | ~5s |
| 200K | 160K | 60 % (≈ 96K) | 24K | ~8s |
| 1M (beta) | 960K | 65 % (≈ 624K) | 48K | ~15s |
| Other | max(ctx−40K, 0.8×ctx) | 60 % | 0.1 × usable | — |

**근거**:
- Gemini 현재 default 50% (PR #13517) 추세
- 작은 모델일수록 단일 tool 라운드 비중 큼 → 보수적
- `getPreflightThreshold()` 는 `getUsableContext()` 와 별도 함수
- p50 latency 는 PR-2 후 P95 측정으로 재조정 (Approval Checklist gate)

---

## 7. Data Schema Changes

### 7.1 `GenericMessage.meta` 확장

```typescript
meta?: {
  compactBoundary?: boolean;
  removedCount?: number;
  compactedAt?: string;        // Layer 1 mark
  originalLength?: number;
  lock?: boolean;              // Layer 1 면제
  compactNum?: number;
  checkpointId?: string;
  boundary?: CompactBoundary;  // §4.3 opaque-state slot
};
```

### 7.2 신규 파일
- `~/.lvis/sessions/<sessionId>.checkpoints.json` — Layer 3 인덱스
- 기존 sessions: 빈 배열로 시작

### 7.3 제거되는 코드 (line accurate)

| 코드 | 위치 | 이유 |
|---|---|---|
| `extractCarryover()` + `meta.carryover` + `ConversationCarryover` interface (3-element lockstep) | `auto-compact.ts:455~514`, `:264`, `engine/llm/types.ts:43` | dead state |
| `tryReactiveCompact()` | `conversation-loop.ts:1356~1388` | Layer 0 사전 예방 |
| context_error 분기 본체 (1027~1074 만, 1076~1102 stream_error/interrupted 유지) | `conversation-loop.ts:1027~1074` | 위와 동일 |
| `engine/turn/stream-collector.ts` reactive 경로 5곳 (`:139,143,154,158`) | code-reviewer 발견 | dead branch |
| `createChildSession()` 호출 in `runRotationCheck` | `conversation-loop.ts:1608` | revert→branch 만 |
| `rotateActive()` 의 `this.sessionId = childSessionId` 줄 | `conversation-loop.ts:1684` | sessionId 불변 |
| `runRotationCheck()` 함수 전체 | `conversation-loop.ts:1520~1645` | Layer 2 자동 북마크 흡수 |
| `decideRotation()` | `auto-compact.ts:93~126` | 동일 |
| extractive `generateSummary()` private | `auto-compact.ts:545~583` | LLM-based 대체 |

**P10 — `isContextLengthError()` deprecation 정책**:
- 본 함수는 *유지* — Layer 0 underestimate 시 사용자 안내 path safety net (R6)
- *외부 경계 (provider error)* 에서 발생하는 정당화된 fallback 으로 분류 (CLAUDE.md No Fallback Code 룰의 정당화 예외)
- 제거 일정: PR-2 머지 후 1개월 내 발생 카운트 0 이면 v4 redesign 에서 deprecate 검토. 1개월 카운트 ≥ 1 이면 영구 유지

### 7.4 Rename
- `microcompactMessages` → `markStaleToolResults`
- `compactMessages` (public) → 폐지, `structured-compact.ts:compactWithBoundary` 로 대체
- `summary-generator.ts:generateSummary` → `generateStructuredSummary`

### 7.5 Forward-incompat schema rollback (P8)

PR-2 머지 후 `meta.boundary` 필드가 사용자 sessions JSONL 에 들어간 뒤 rollback 시:
- v3 → v2 코드 복귀 시 `meta.boundary` 필드는 *unknown field 로 graceful 무시* (현 LVIS session-store 가 unknown meta passthrough 라 안전)
- v3 → v1 코드 복귀 시 동일
- 단 v3 의 `markStaleToolResults` 가 만든 `meta.compactedAt` 은 v2 의 `meta.stripped` 와 의미 다름 → v2 로 rollback 시 *원본 content 가 보존된 채* 노출됨 (lossless rollback 가능)
- forward-incompat 시나리오 회귀 테스트: `tests/migration/v3-to-v2-rollback.test.ts` 신규

---

## 8. Migration — 2 PR Roadmap

### PR-1: Cleanup + Layer 1 marking (low risk)
- dead state 제거 (3-element lockstep)
- rename
- `markStaleToolResults` (content 보존, 직렬화 stub)
- preserveRecentToolResults 4→8, preserveRecentMessages 4→12
- SubAgentRunner stamping policy: PostTurnHookChain 주입
- §10 신규 테스트: JSONL meta round-trip + idempotent + lock 면제 + v3→v2 rollback (P8)

**검증**: 기존 회귀 0 + 신규 통과

### PR-2: Layer 0 + Layer 2 + Layer 3 + JSONL pagination (medium-high risk; P6 통합)

**P6 — R12 JSONL append 처리**: §10.4 stress test 가 R12 에 막히지 않도록 *PR-2 안에서* lazy-load + index pagination 구현.

- `engine/structured-compact.ts` (LLM call + 12-section + opaque-state slot)
- `memory/checkpoint-store.ts` (Layer 3 storage)
- `memory/session-store-v2.ts` (P6: lazy-load + index pagination — 최근 N turn 만 startup read)
- `ui/renderer/components/CheckpointDivider.tsx` (revert UI)
- `queryLoop` Layer 0 pre-flight guard (step 5/6 사이, P1 동기 chain)
- 분기 본체 + collector reactive 경로 부분 삭제
- `cumulativeUsage` reset (Layer 2 후)
- `getPreflightThreshold()` 별도 함수
- `runRotationCheck`/`decideRotation`/`rotateActive sessionId` *제거*
- §4.5.9 ⑧ slot 갱신 — system-prompt-builder 수정
- `Object.freeze(boundary)` (P7)
- `isCompacting` lock (P9 concurrency)
- Korean 가중치 algorithm (P11)
- `isContextLengthError` 유지 + deprecation 카운트 로그 (P10)

**검증**:
- 회귀: 기존 reactive-compact.test.ts → Layer 0 사전 차단
- 신규: pre-flight guard fixture (50/55/60/65 per model)
- 신규: opaque-state slot 직렬화 vendor 분기
- 신규: P1 sync chain 회귀 (step 9 이전 step 6 진입 차단)
- 신규: P9 concurrency lock (2 turn 동시 진입 시 두번째 await)
- 신규: P11 한글 비율 detection (50:50 mixed / 100% 한글 / 100% 영문 fixture)
- 신규: P8 v3→v2 rollback
- 신규: §10 LLM-as-judge recall eval (5 scenarios)
- e2e: 200 turn × 평균 1K input → mid-loop compact 0회 + sessionId 1개

---

## 9. Risks + Mitigations

| 위험 | 영향 | 완화 |
|---|---|---|
| R1: Layer 2 LLM call 실패 | 압축 실패 | 1회 재시도 → 실패 시 Layer 1 marking 강제 truncate |
| R2: SUMMARY_TEMPLATE 형식 위반 | parse 실패 | parser 검증 + 1회 재호출 + raw fallback (P4 절차 4) |
| R3: Layer 0 토큰 추정 부정확 | 늦게 트리거 | 한글 비율 가중치 (P11) + per-model 보수 임계 |
| R4: 디스크 무한 성장 | JSONL 폭증 | Layer 1 marking 의 "원본 보존" 은 메모리 only; 디스크는 stub |
| R5: revert 후 branch | history 충돌 | 자동 새 sessionId fork |
| R6: Layer 0 underestimate → context_error | unhandled error | safety net `isContextLengthError()` 유지 (P10) |
| R7: `/checkpoint` 와 `/compact` 의미 분리 | 사용자 혼동 | `/compact` = Layer 2 강제 트리거, `/checkpoint <label>` = 라벨링만 |
| R8: 기존 fork child session 호환 | UI 혼동 | 마이그레이션 코드 없음 — 기존 fork 그대로 표시 |
| R9: prompt-injection 재진입 | boundary 통과 | system block + fence wrap |
| R10: Layer 2 LLM 비용 | turn 당 +1 LLM call | 동일 vendor 동급 모델; ~$1/주 (Haiku 200K 압축 ~$0.05 × 20회) |
| R11: boundary user-role LLM 오해 | R9 와 함께 | system block (R9 fix 동시 해결) |
| **R12: JSONL 무한 append** | startup load 폭증 | **PR-2 안 lazy-load + index pagination (P6)** |
| **R13: Layer 2 estimator drift (residual)** | Layer 0 estimateTokens 가 실제 wire format 보다 underestimate 시 늦게 트리거 — 단 `Object.freeze(boundary)` *invariant* + sync chain 으로 ⑧ slot/Layer 3/history[0] 3 view inconsistency 자체는 hard-blocked | per-model 보수 임계 + P11 한글 가중치. **(`Object.freeze` 는 mitigation 이 아닌 *spec invariant*)** |
| **R14: 다중 turn 동시 Layer 2 진입** | double compact / cumulativeUsage 이중 reset | `isCompacting` lock per ConversationLoop (P9) |

---

## 10. Test Plan

### 10.1 Unit
- `structured-compact.test.ts`: 12-section parse / 형식 위반 → 재시도 / raw fallback / `Object.freeze` 검증
- `marking.test.ts`: idempotent / lock 면제 / 200자 / toolUseId / **JSONL meta round-trip** / **v3→v2 rollback (P8)**
- `pre-flight-guard.test.ts`: 모델별 임계 / **한글 가중치 (P11) — 100% 한글 / 100% 영문 / 50:50 mixed** / cumulativeUsage reset
- `concurrency.test.ts` (P9): 2 turn 동시 진입 시 lock 동작

### 10.2 Integration
- `infinity-session.integration.test.ts`: 100 turn → mid-loop reactive 0 / sessionId 1
- `revert-to-checkpoint.integration.test.ts`: compact 3회 → revert #2 → branch fork
- **`recall-eval.integration.test.ts`**: golden quiz set × pre/post compact → LLM-as-judge

### 10.3 E2E (Playwright)
- ChatView compact 3회 → CheckpointDivider 클릭
- revert view-mode UI
- "여기서부터 다시" 트리거

### 10.4 Stress
- 7일 / 1000+ turn / 평균 5K input → memory/disk/token-budget 안정
- 메트릭: Layer 2 발생률, 평균 freed, p50/p95 latency, **startup load time (P6 R12 검증)**

### 10.5 Vendor 직렬화
- Anthropic: fence-wrap, prompt-injection vector 차단
- Gemini: system instruction 매핑
- (향후) OpenAI: `openaiCompactionItem` as-is (P2)

---

## 11. Open Questions

대부분 v2/v3 default 결정 완료. 남은 항목:

1. **Q1: Critical Context LVIS-specific** — 사용자 도메인 입력 가장 가치 (default: 활성 plugin / routine ID / PR / 권한 모드)
2. ~~Q2~~ 결정됨 (architect v3 정정) — `markStaleToolResultsHook` *만* SubAgentRunner 에 주입. 전체 PostTurnHookChain 은 `undefined` 유지 (isolation contract 보존). §4.2 참조
3. ~~Q3~~ 결정됨 — `/recompact-all` 커맨드는 follow-up PR

---

## 12. Approval Checklist

- [x] 5-reviewer (v1) 통합 정정 반영
- [x] 3-way regression (v2) patches P1-P11 적용
- [ ] User decision on §11 Q1 (Critical Context LVIS-specific)
- [ ] architect 1명 short-form 재회귀 (P1 sync chain 정확성)
- [ ] PR-1 → PR-2 순차 진행
- [ ] PR-1 머지 후 1주 dogfood → R10 비용 실측 → PR-2 임계값 재조정
- [ ] PR-2 머지 후 §10.4 stress test CI 자동화

---

## v2 → v3 변경 요약

| Patch | 항목 | 위치 |
|---|---|---|
| P1 | Algorithm sync chain (step 9 전 step 6 진입 차단) | §4.3.3 + R13 |
| P2 | OpenAI opaque slot — compaction item 전체 (`openaiCompactionItem`) | §4.3.1 interface |
| P3 | §6 임계값 "LVIS 보수 default" 표기 | §6 본문 |
| P4 | SUMMARY_TEMPLATE 절차 규칙 (5개) | §5.1 머리말 |
| P5 | opaque-state slot YAGNI 분석 표 | §4.3.1 |
| P6 | R12 JSONL append PR-2 안 처리 | §8 PR-2 + R12 |
| P7 | `Object.freeze(boundary)` | §4.3.1 + algorithm step 6 |
| P8 | v3→v2 schema rollback | §7.5 + 신규 테스트 |
| P9 | `isCompacting` lock (concurrency) | §4.3.3 + R14 |
| P10 | `isContextLengthError` deprecation 정책 | §7.3 footer |
| P11 | 한글 비율 detection algorithm | §4.1 + 테스트 fixture |

---

**End of v3 draft**.
