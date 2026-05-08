# Infinity Session Redesign v2 — opaque-state slot + 2-PR migration

**Status**: 🟡 DRAFT (post-5-reviewer revision)
**Date**: 2026-05-08
**Supersedes**: `infinity-session-redesign-v1.md` (5-reviewer 통합 정정 반영)
**Architecture ref**: `architecture.md` v4 §4.5 / §4.6 / §5
**Review trail**: architect / critic / code-reviewer / document-specialist / codex CLI 합의 반영

> v1 → v2 핵심 변경 (auto-mode default 결정):
> - **D1: 3-source 비교** — Codex CLI 칼럼은 footnote 로 강등 (차용 0건)
> - **D2: opaque-state slot 인터페이스** — provider-neutral `compact_boundary` item (multi-vendor)
> - **D3: 2-PR 마이그레이션** — v1 의 PR-2/PR-3 통합 (transitional 모순 회피)
> - **D4: 보수 임계 50/55/60/65** — Gemini 50% 추세 + Codex 미검증 반영
> - **D5: 12-section SUMMARY_TEMPLATE** — OpenCode 7 + GPT-5 prompting 5

---

## 1. Goal — 인피니티 세션 정의

> 사용자가 세션을 명시적으로 종료하지 않은 채 며칠~몇 주 단위로 같은 sessionId 안에서 대화를 이어가도, *대화 품질 단조 비감소* + *주제 일관성 유지* + *임의 시점 회귀 가능* 을 만족시키는 단일 세션 모델.

### 1.1 측정 가능한 성공 지표 (LLM-as-judge fixture 포함)

| 지표 | 목표 | 측정 fixture |
|---|---|---|
| Mid-loop reactive compact 발생률 | 0/turn | 진단 로그 `queryLoop: context_error caught` 카운트 |
| 압축 후 LLM empty-response 비율 | < 0.1 % | 동일 로그 + retry empty 카운트 |
| 세션 fork (sessionId 변경) 빈도 | 0 (사용자 명시 fork 만) | sessionId 분기 카운트 |
| **Goal/Decisions 보존률 ≥ 95%** | **golden quiz set 자동 평가** | `tests/recall-eval/golden-quiz-set.json` 의 N 개 quiz × pre/post compact 답변 → LLM-as-judge (별도 모델, embedding similarity ≥ 0.85 또는 judge OK) |
| 세션 길이 한도 | 1000+ turn 통과 | 7일 stress test |

**Recall Eval 자동화**: `engine/__tests__/recall-eval.integration.test.ts` 신규. fixture 형식:
```json
{
  "scenarios": [
    {
      "name": "auth refactor 30 turn",
      "transcript": "...",
      "quizzes": [
        {"q": "사용자가 처음 요청한 목표?", "expected_keywords": ["JWT", "auth", "refactor"]},
        {"q": "마지막에 결정된 토큰 store?", "expected_keywords": ["redis"]}
      ]
    }
  ]
}
```

### 1.2 Why-not-fork? — 새 세션 vs same-session (devil's advocate)

| 옵션 | 장점 | 단점 |
|---|---|---|
| **새 세션 fork** (Codex Memories 모델) | mental clean slate, 검색 인덱스 단순, 압축 이슈 회피 | 회상 비용 (이전 결정/파일 재발견) ↑, *routine* 같은 지속 task 와 mismatch |
| **same-session compact** (Copilot/OpenCode 모델, 본 청사진) | 회상 0 비용, routine/proactive engine 과 정합 | 압축 정확도 의존, JSONL 누적, 측정 복잡 |

채택 근거: LVIS 의 §7 Proactive Engine + 사용자 routine 시나리오는 *지속성* 을 가정. 매일 아침 routine 이 어제 컨텍스트를 회상해야 함. fork 모델 시 routine 마다 cross-session memory 수동 관리 필요 → 사용자 입장 mental overhead. same-session 의 압축 정확도 리스크는 §1.1 KPI + R1-R12 mitigation 으로 관리.

### 1.3 Non-goals
- *latent-preserving handoff* — Anthropic/Gemini 는 OpenAI 의 reasoning `encrypted_content` 동등 API 미제공 (Non-goal 는 *적용 불가* 의 의미)
- 月 단위 풀텍스트 회귀 (preview + checkpoint summary 로 충분)
- Multi-device cross-session sync (별도 PR)

---

## 2. 현재 구조의 핵심 문제 (요약)

| 문제 | 증거 (line accurate) |
|---|---|
| 5 메커니즘 중복 | microcompact + auto-compact + reactive-compact + rotation Tier 1/2/3 — 트리거 겹침 |
| `cumulativeUsage` lifetime 누적 의미 | `conversation-loop.ts:1135` 매 라운드 `+= adjustedIn`. compact 후 reset 누락 |
| mid-loop reactive compact 위험 | `conversation-loop.ts:1027~1074` (분기 본체) — provider error 후 history mutate → LLM tool-chain 손실 |
| dead state | `meta.carryover` + `extractCarryover()` (`auto-compact.ts:455~514`, line 264) — `grep -rn meta\.carryover src/prompts src/memory` → 0 hit |
| rotation = sessionId fork | `conversation-loop.ts:1684` `this.sessionId = childSessionId` — child session 분기 |

---

## 3. References — 3-source 비교 (Codex 는 footnote)

| 차원 | OpenCode | Gemini CLI | Copilot Chat |
|---|---|---|---|
| 트리거 | 끝 40K preserve (`PRUNE_PROTECT`) + ≥20K free 가능 (`PRUNE_MINIMUM`) 시 | **현재 50%** (`COMPRESSION_TOKEN_THRESHOLD = 0.5`, 이전 0.7), key `model.compressionThreshold` | 모델 한도 근접 자동 |
| 1차 시도 | 부분 마킹 — `part.state.time.compacted = Date.now()` (물리 삭제 X)<sup>※</sup> | head/tail 분할, head 만 LLM 요약 | 자동 background 요약 |
| 2차 시도 | SUMMARY_TEMPLATE: Goal / Constraints & Preferences / Progress / Key Decisions / **Relevant Files** / Next Steps / Critical Context (7 sections) | XML 스냅숏: goal / knowledge / fs state / plan | LLM 요약 |
| 보존 | 끝 40K verbatim, **skill 도구 출력 절대 prune 금지** (`PRUNE_PROTECTED_TOOLS = ["skill"]`) | "Reverse Token Budget": 최근 verbatim, 오래된 30줄 truncate (`COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET = 50_000`) | preserve recent |
| 클러스터링 | 시간 기반 | Union-Find episode (실험, `COMPRESSION_STRATEGY` flag 뒤, default X) | 시간 기반 |
| 체크포인트 ↔ compact | 분리 | 분리 | **별개 mechanism** — `/compact` 는 요약, `chat.checkpoints` 는 파일 스냅숏 (서로 독립) |

<sup>※</sup> v1 은 이를 "stamping" 이라 명명했으나 OpenCode 자체 라벨 아님. v2 는 *part marking* 표현 사용.

LVIS 차용 결정:
- **part marking 패턴** (OpenCode) — 물리 삭제 대신 marking
- **SUMMARY_TEMPLATE** (OpenCode 7 + GPT-5 prompting 5 = 12 섹션, §5 참조)
- **50% 임계** (Gemini 현재값) 을 200K 모델 baseline 으로 — per-model 분기는 §6
- **compact ≠ checkpoint 분리** (Copilot 정정) — LVIS 의 Layer 2 (compact) 와 Layer 3 (checkpoint) 도 분리 mechanism. 단 Layer 2 발생 시 Layer 3 가 *자동 북마크* 만 추가 (파일 생성 X, in-memory entry).

> **Footnote: Codex CLI 차용 0건 사유**
> Codex CLI 의 `/responses/compact` 패턴은 OpenAI Responses API 종속 (`encrypted_content` 가 ZDR/AES-encrypted opaque token). Anthropic/Gemini 는 동등 reasoning-state 재주입 API 미제공. *그러나 청사진 §4.3 의 `opaque-state slot` 추상화는 OpenAI 차용 path 를 *향후* 열어둠* — codex CLI 리뷰 권장 패턴.

---

## 4. Architecture — 3-Layer Model

### 4.1 Layer 0: Pre-flight Guard (per-round, no LLM)

**위치**: §4.5.2 step 5 (`HISTORY_APPEND`) 직후 / step 6 (`PROMPT_ASSEMBLE`) 직전.
즉 user message 가 history 에 들어간 *직후*, system prompt 가 build 되기 *직전*. `conversation-loop.ts:723~742` 사이.

**알고리즘**:
```
estimated   = estimateMessagesTokens(history)         # 한글 가중치 보정 §6
preflight   = getPreflightThreshold(provider, model)  # NEW 함수, getUsableContext 와 분리
if estimated >= preflight:
    runLayer2Compact(reason="preflight")              # cumulativeUsage 리셋 포함
```

**효과**:
- mid-loop reactive compact 영구 제거 → context_error 분기 본체 (`conversation-loop.ts:1027~1074`) 삭제 가능
- §4.5.9 ⑧ Compact Summary slot 은 *Layer 2 결과* 로 채워지므로 system prompt 정합성 유지

**불변식**:
- LLM 호출 0
- estimateTokens 한글 가중치: `text.length × 1.3 / 4 + 1` (한글 비율 ≥ 50% 자동 적용; 측정 fixture §10)

### 4.2 Layer 1: Part Marking (lazy, idempotent, no LLM)

**현 microcompact 대체**.

**위치**: `auto-compact.ts:markStaleToolResults` (rename from `microcompactMessages`).

**변경점 vs v1**:
- `meta.stripped: true` + content 교체 → **`meta.compactedAt: ts` 만 마킹, content 보존**
- 직렬화 단계 (provider 호출 직전) 에서 `compactedAt` 마킹된 tool_result 만 stub 으로 wire-format 생성
- 원본 history 는 메모리 내 *영구 보존* — UI / checkpoint preview / 회귀 디버깅 가능
- **디스크 직렬화 시점에는 stub** (R4 디스크 폭증 회피)
- stub 임계: tool_result 길이 ≥ 200 자 인 경우만
- 끝 N 개 tool_result preserve — **N = 8** (현 4 → 2배)

**불변식**:
- skill-route 도구 결과 + `meta.lock: true` 있는 메시지는 marking 면제 (OpenCode `PRUNE_PROTECTED_TOOLS` 패턴)
- toolUseId 절대 변경 X
- idempotent — 이미 `compactedAt` 있으면 no-op
- **SubAgentRunner child loop 도 동일 적용** — `subagent-runner.ts:151` 의 `postTurnHookChain: undefined` 를 `postTurnHookChain: parentHookChain` 으로 변경 OR fallback 분기에서 `markStaleToolResults` 직접 호출 (PR-1 안에서 결정)

### 4.3 Layer 2: Structured Compact + opaque-state slot (LLM, 임계 도달 시)

**현 auto-compact + reactive compact 통합 대체**.

**위치**: `engine/structured-compact.ts` (신규).

**핵심 추상화 — opaque-state slot 인터페이스** (codex CLI 권장 차용):

```typescript
interface CompactBoundary {
  templateVersion: 1;                  // §5 진화 시 backward-compat
  vendorOpaqueState?: {                // OpenAI 차용 path (향후)
    vendor: "openai";
    encryptedContent: string;          // /responses/compact 결과 그대로
  };
  structuredSummary: ParsedSummary;    // Anthropic/Gemini 의 차선
  recentVerbatim: GenericMessage[];    // 끝 N 토큰 (Cline 룰)
  pinnedArtifacts: string[];           // skill outputs / lock 메시지
  toolBoundaryLedger: ToolCallSummary[]; // 마지막 K 라운드의 tool_use/result 요약
}
```

벤더 분기 직렬화 (`engine/llm/vercel/adapter.ts` 확장):
| Vendor | boundary message 직렬화 |
|---|---|
| OpenAI (향후) | `vendorOpaqueState.encryptedContent` 를 input items 에 그대로 포함 |
| Anthropic | system block 에 `<compact-boundary>...</compact-boundary>` fence wrap (§4.5.11 prompt-injection fence 패턴 차용 — user-role X) |
| Gemini | system instruction 에 동등 fence |

**알고리즘**:
```
1. messagesToCompact = history.slice(0, len - PRESERVE_RECENT_TOKENS)
2. messagesToPreserve = history.slice(len - PRESERVE_RECENT_TOKENS)
3. structuredSummary = await callLLM(SUMMARY_TEMPLATE_PROMPT, messagesToCompact)
4. pinnedArtifacts = collectLocked(messagesToCompact)
5. ledger = summarizeToolCalls(messagesToCompact.slice(-K_TOOL_LEDGER))
6. boundary = { templateVersion: 1, structuredSummary, recentVerbatim: messagesToPreserve, pinnedArtifacts, toolBoundaryLedger: ledger }
7. newHistory = [boundaryAsSystemBlock(boundary), ...messagesToPreserve]
8. cumulativeUsage = estimateMessagesTokens(newHistory)   # 의미 정합 reset
9. checkpointStore.appendBookmark(boundary, ts)            # Layer 3 in-memory entry
```

**§4.5.9 ⑧ Compact Summary slot + `<prior-context-summary>` fence 의 운명** (architect C1 정정):
- ⑧ slot 은 **유지** — Layer 2 의 `structuredSummary` 가 ⑧ slot 을 채움
- `<prior-context-summary>` fence 는 **유지** — 모든 boundary content 가 fence-wrapped 로 직렬화
- v1 의 "system prompt 추가 주입 불필요" 단언은 *false* — system prompt + history 양쪽에 일관 주입 (단 동일 source `boundary` object 에서 파생되므로 race 없음)

**`runRotationCheck` 함수 폐지** — Layer 2 가 자동 Layer 3 북마크 추가하므로 별도 rotation 결정 트리 불필요.

### 4.4 Layer 3: Checkpoint (same sessionId, 북마크 chain)

**v1 의 fork 동작 폐지**.

**위치 (module boundary 정합)**:
- `memory/checkpoint-store.ts` — storage owner (architect M3 정정)
- `engine/checkpoint-trigger.ts` — Layer 2 호출자가 inject only
- `ui/renderer/components/CheckpointDivider.tsx` — UI owner

**Trigger** (compact ≠ checkpoint 분리, Copilot 정정):
- Layer 2 발생 시 **자동 북마크 추가** (in-memory, 파일 생성 X)
- LLM `[checkpoint]` 마커 → 단순 라벨링 신호 (compact 트리거 X — 다운그레이드)
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
- 클릭 시 sessionId 그대로, history 를 `messageIndexAtCreation` 시점까지 슬라이스 view 모드
- "여기서부터 다시" → 그 시점 history 만 LLM 에 전송 + 새 turn (sessionId 불변)
- Branch 발생 시 (revert 후 새 입력) **자동 새 sessionId fork** — 명시적 분기 (R5 mitigation)

**v1 → v2 변경**: `rotateActive()` 의 `this.sessionId = childSessionId` 줄 *제거*. `createChildSession()` 는 revert→branch 시에만 호출.

---

## 5. SUMMARY_TEMPLATE — 12-Section (OpenCode 7 + GPT-5 prompting 5)

### 5.1 LLM 프롬프트

```
당신은 대화 상태 관리자입니다. 아래 대화를 다음 12 섹션으로 요약하세요.
정보 손실 최소화가 최우선이며, 추측·창작 금지. 본문에 없는 사실은 적지 마세요.

# Session State as of {{timestamp}} (compact #{{N}}, templateVersion 1)

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
잃으면 안 되는 것 — secret/ticket/endpoint/규칙. 본문 명시된 것만.
LVIS 도메인 specific (활성 plugin / 활성 routine ID / 작업 PR 번호 / 권한 모드 propose-or-auto) 도 포함.

## Current Plan
직전 LLM 의 계획 (multi-step 작업 시 step 1/N 진행 상황).

## Verification State
무엇이 검증되었고 무엇이 미검증인지 — "build pass / typecheck pass / e2e pass / human review".

## Open Blockers
풀려야 진행 가능한 외부 의존 — "사용자 결정 대기", "CI 실패", "API 응답 대기".

## Unsafe Pending Actions
사용자 승인 없이 실행되면 안 되는 액션 — "DELETE FROM ...", "git push --force".

## Last Tool Boundary
가장 최근 tool_use/tool_result 쌍의 요약 — round 번호 + tool 이름 + 결과 요지.

대화:
{{conversationText}}
```

### 5.2 Parser + version 분기

`structured-compact.ts:parseSummary(text, version)`:
- v1: 12 헤더 모두 존재해야 valid (Critical Context / Current Plan / 등 7개 + 5개)
- 누락 시 1회 LLM 재호출
- 형식 위반 시 raw 텍스트 그대로 `boundary.structuredSummary.raw` 에 fallback (parser 깨져도 LLM 은 raw text 읽을 수 있음)

### 5.3 templateVersion 진화 정책

- `boundary.templateVersion` 필드 필수
- v2 도입 시 v1 boundary 들은 그대로 유지 (`parseSummary(text, 1)`)
- 마이그레이션은 새 compact 시점부터 자동 v2 적용 (강제 변환 X)

---

## 6. Per-Model Thresholds (보수 50/55/60/65)

| Model context | Usable (Cline buffer) | Layer 0 pre-flight 임계 (`getPreflightThreshold`) | Layer 2 PRESERVE_RECENT_TOKENS | p50 압축 latency 추정 (Haiku) |
|---|---|---|---|---|
| 64K | 37K | 50 % (≈ 18K) | 6K | ~3s |
| 128K | 98K | 55 % (≈ 54K) | 12K | ~5s |
| 200K | 160K | 60 % (≈ 96K) | 24K | ~8s |
| 1M (beta) | 960K | 65 % (≈ 624K) | 48K | ~15s |
| Other | max(ctx−40K, 0.8×ctx) | 60 % | 0.1 × usable | — |

**임계 보수화 근거** (v1 70/75/80/85 → v2 50/55/60/65):
- Gemini 현재 default 50% (PR #13517 이후) 추세 반영
- Codex 83.5% 는 미검증 → 의존 X
- 작은 모델일수록 단일 tool 라운드 비중 큼 → 더 보수적
- `getPreflightThreshold()` 는 `getUsableContext()` 와 별도 함수 (code-reviewer M-2 정정)

**Latency 예측 근거**: Haiku input 100K 압축 SUMMARY_TEMPLATE 응답 ~5s (output ~1K tokens). 사용자 체감 차단형이므로 §10 의 stress test 에서 P95 측정 후 임계 재조정 필요.

---

## 7. Data Schema Changes

### 7.1 `GenericMessage.meta` 확장

```typescript
meta?: {
  // existing — 유지
  compactBoundary?: boolean;
  removedCount?: number;
  // renamed: stripped → compactedAt (Layer 1 marking)
  compactedAt?: string;        // ISO 8601 — Layer 1 mark 시각
  originalLength?: number;     // 유지 (디버깅)
  // new
  lock?: boolean;              // Layer 1 면제
  compactNum?: number;         // Layer 2 boundary 일 때 #N
  checkpointId?: string;       // Layer 3 anchor
  boundary?: CompactBoundary;  // §4.3 opaque-state slot
  // removed
  // carryover?: ConversationCarryover;  // dead state
  // stripped?: boolean;                  // → compactedAt 통합
};
```

### 7.2 신규 파일
- `~/.lvis/sessions/<sessionId>.checkpoints.json` — Layer 3 인덱스
- 기존 sessions: 빈 checkpoints 배열로 시작 (마이그레이션 없음)

### 7.3 제거되는 코드 (line accurate, code-reviewer 정정 반영)

| 코드 | 위치 | 이유 |
|---|---|---|
| `extractCarryover()` 함수 + `meta.carryover` + **`ConversationCarryover` interface** (`engine/llm/types.ts:43`) — 3-element lockstep | `auto-compact.ts:455~514`, `:264`, `engine/llm/types.ts:43` | dead state |
| `tryReactiveCompact()` | `conversation-loop.ts:1356~1388` | Layer 0 사전 예방 |
| context_error 분기 본체 (1027~1074 만, 1076~1102 stream_error/interrupted 분기는 유지) | `conversation-loop.ts:1027~1074` | 위와 동일 |
| `engine/turn/stream-collector.ts` reactive 경로 5곳 (`:139,143,154,158`) | code-reviewer 발견 | dead branch 정리 |
| `createChildSession()` 호출 in `runRotationCheck` | `conversation-loop.ts:1608` | revert→branch 경로로만 호출 |
| `rotateActive()` 의 `this.sessionId = childSessionId` 줄 | `conversation-loop.ts:1684` | sessionId 불변 |
| `runRotationCheck()` 함수 전체 | `conversation-loop.ts:1520~1645` | Layer 2 자동 북마크로 흡수 |
| `decideRotation()` 3-tier 함수 | `auto-compact.ts:93~126` | 동일 |
| extractive `generateSummary()` private | `auto-compact.ts:545~583` | LLM-based 로 대체 |

`isContextLengthError()` 함수는 **유지** — Layer 0 underestimate 시 사용자 안내 path safety net (R6 정정).

### 7.4 Rename
- `auto-compact.ts:microcompactMessages` → `markStaleToolResults`
- `auto-compact.ts:compactMessages` → 폐지 (LLM 기반 `structured-compact.ts:compactWithBoundary` 로 대체)
- `summary-generator.ts:generateSummary` → `generateStructuredSummary`

---

## 8. Migration — 2 PR Roadmap

### PR-1: Cleanup + Layer 1 marking (low risk)
- dead state 제거: `extractCarryover` + `meta.carryover` + `ConversationCarryover` interface — *3-element lockstep*
- rename: `summary-generator.ts:generateSummary` → `generateStructuredSummary`
- `microcompactMessages` → `markStaleToolResults` + content 보존 + 직렬화 stub
- preserveRecentToolResults 4→8, preserveRecentMessages 4→12
- Layer 1 marking 패턴 적용
- **SubAgentRunner stamping 정책**: `subagent-runner.ts` 의 child loop 가 `markStaleToolResults` 호출하도록 fallback 분기 명시 (옵션: PostTurnHookChain 주입 또는 직접 호출)
- §10 신규 테스트: JSONL meta round-trip + idempotent + lock 면제

**검증**: 기존 unit/integration test 회귀 0 + 신규 테스트 통과

### PR-2: Layer 0 + Layer 2 + Layer 3 통합 (medium risk; v1 의 PR-2 + PR-3 통합)
**v1 PR-2/PR-3 분리는 transitional 모순 발생 → v2 는 단일 PR 로 통합** (architect M2 정정).

- `engine/structured-compact.ts` 신규 — LLM call + 12-section SUMMARY_TEMPLATE + opaque-state slot
- `memory/checkpoint-store.ts` 신규 — Layer 3 storage
- `ui/renderer/components/CheckpointDivider.tsx` revert UI (view-mode + 명시적 fork)
- `queryLoop` Layer 0 pre-flight guard (step 5/6 사이)
- `tryReactiveCompact()` + context_error 분기 본체 + stream-collector reactive 경로 *부분 삭제* (line range 정확)
- `cumulativeUsage` reset (Layer 2 후)
- `getPreflightThreshold()` 별도 함수 (`shared/context-budget.ts` 확장)
- `runRotationCheck()` + `decideRotation()` + `rotateActive` sessionId 변경 *제거*
- §4.5.9 ⑧ slot + fence 는 Layer 2 결과로 채워지도록 system-prompt-builder 수정

**검증**:
- 회귀: 기존 reactive-compact.test.ts → Layer 0 사전 차단 확인
- 신규: pre-flight 가드 fixture (50/55/60/65% per model)
- 신규: opaque-state slot 직렬화 vendor 분기 (Anthropic fence-wrap 검증)
- 신규: §10 LLM-as-judge recall eval (5 scenarios)
- e2e: 200 turn × 평균 1K input → mid-loop compact 0회 + sessionId 1개

---

## 9. Risks + Mitigations (R9-R12 추가)

| 위험 | 영향 | 완화 |
|---|---|---|
| R1: Layer 2 LLM call 실패 | 압축 못 함 | 1회 재시도 → 실패 시 Layer 1 marking 강제 truncate |
| R2: SUMMARY_TEMPLATE 형식 위반 | parse 실패 | parser 검증 + 1회 재호출 + raw 텍스트 fallback (`boundary.structuredSummary.raw`) |
| R3: Layer 0 토큰 추정 부정확 (한글) | 늦게 트리거 | 한글 비율 가중치 1.3 + per-model 보수적 임계 |
| R4: 디스크 무한 성장 | 7일 후 sessions JSONL 수십 MB | Layer 1 marking 의 "원본 보존" 은 *메모리* 만; 디스크 직렬화는 stub 화 |
| R5: revert 후 branch | 새 입력 시 forward history 충돌 | 자동 새 sessionId fork (명시적 분기) |
| R6: Layer 0 underestimate → context_error 미인식 | unhandled error | safety net: `isContextLengthError()` *유지*, fail 시 사용자 안내 ("/compact 실행 또는 새 세션 시작") |
| R7: `/checkpoint` 와 `/compact` 의미 분리 | 사용자 혼동 | `/compact` = Layer 2 강제 트리거, `/checkpoint <label>` = 라벨링만 |
| R8: 기존 fork 된 child session 호환 | UI 혼동 | 마이그레이션 코드 없음 — 기존 fork 는 separate sessions 그대로 표시 |
| **R9: prompt-injection 재진입 (architect C2)** | 사용자 발화의 악성 instruction 이 boundary 통과 | boundary 는 user-role X — system block + `<compact-boundary>...</compact-boundary>` fence wrap |
| **R10: Layer 2 LLM 비용 폭증 (critic)** | turn 당 1회 추가 LLM call | 동일 vendor 동급 모델 사용; 200K 모델 압축 1회 ≈ Haiku $0.05 (입력 100K × $0.50/M); 7일 1000-turn 압축 ~20 회 → ~$1 |
| **R11: boundary 가 user-role 이면 LLM 이 "동일 요청 반복?" 오해 (critic)** | R9 와 함께 mitigated | boundary 는 system block (R9 fix 가 동시 해결) |
| **R12: JSONL `<sessionId>.jsonl` 무한 append (critic)** | startup load 시간 폭증 | session-store 에 lazy-load + index pagination (최근 N turn 만 read on startup); 별도 follow-up PR |

---

## 10. Test Plan

### 10.1 Unit
- `structured-compact.test.ts`: 12-section parse / 형식 위반 → 재시도 / raw fallback
- `marking.test.ts`: idempotent / lock 면제 / 200자 임계 / toolUseId 보존 / **JSONL meta round-trip 신규**
- `pre-flight-guard.test.ts`: 모델별 임계 / 한글 가중치 / cumulativeUsage reset

### 10.2 Integration
- `infinity-session.integration.test.ts`: 100 turn → mid-loop reactive 0 / sessionId 1 / boundary chain 자동
- `revert-to-checkpoint.integration.test.ts`: compact 3회 → revert #2 → branch (새 sessionId fork)
- **`recall-eval.integration.test.ts` (M-5 신규)**: golden quiz set × pre/post compact → LLM-as-judge

### 10.3 E2E (Playwright)
- ChatView compact 3회 → CheckpointDivider 클릭 가능
- revert view-mode UI 식별
- "여기서부터 다시" 트리거 → 새 sessionId fork 확인

### 10.4 Stress
- 7일 / 1000+ turn / 평균 5K input → memory/disk/token-budget 안정
- 메트릭: `~/.lvis/audit.jsonl` 분석 — Layer 2 발생률, 평균 freed tokens, p50/p95 latency

### 10.5 Vendor 직렬화 검증
- Anthropic: boundary fence-wrap, prompt-injection vector 차단
- Gemini: system instruction 매핑
- (향후) OpenAI: encrypted_content as-is 통과

---

## 11. Open Questions (사용자 결정 필요)

대부분 v2 에서 default 결정 완료. 남은 항목:

1. **Q1: SUMMARY_TEMPLATE Critical Context 의 LVIS 도메인 specific 항목**
   - 현 default: 활성 plugin / 활성 routine ID / 작업 PR 번호 / 권한 모드
   - 추가 후보: 현재 활성 sub-agent 깊이, 마지막 user-confirmation 이력, 현재 활성 model vendor
   - **사용자 도메인 입력 가장 가치**
2. **Q2: SubAgentRunner child-loop 의 stamping path** — PostTurnHookChain 주입 vs fallback 직접 호출
   - 추천: PostTurnHookChain 주입 (단일 source of truth)
3. **Q3: `templateVersion` 진화 시 backward-compat** — 현 default 강제 변환 X. 사용자가 v1 → v2 일괄 재요약 원하면 별도 `/recompact-all` 커맨드?

---

## 12. Approval Checklist

- [x] 5-reviewer 통합 정정 반영 (architect / critic / code-reviewer / document-specialist / codex CLI)
- [ ] User decision on §11 Q1-Q3
- [ ] Implementation PR-1 → PR-2 순차 진행
- [ ] PR-1 머지 후 1주 dogfood → R10 비용 실측 → PR-2 임계값 재조정
- [ ] PR-2 머지 후 §10.4 stress test 자동화 (별도 CI workflow)

---

## v1 → v2 변경 요약 표

| 항목 | v1 | v2 |
|---|---|---|
| Reference | 4-source | 3-source + Codex footnote |
| Boundary message role | `user` | system block + fence-wrap (opaque-state slot) |
| PR 분할 | 3 (1 + 2 + 3) | 2 (1 + 2&3 통합) |
| 임계값 | 70/75/80/85 | 50/55/60/65 |
| SUMMARY_TEMPLATE | 7 sections | 12 sections (7 OpenCode + 5 GPT-5) |
| Layer 0 위치 | step 7 직전 | step 5/6 사이 |
| §4.5.9 ⑧ slot + fence | 폐지/충돌 | 유지 (Layer 2 결과 주입) |
| stream-collector cleanup | 누락 | 명시 |
| SubAgentRunner stamping | 누락 | PR-1 안 명시 |
| ConversationCarryover lockstep | 누락 | 3-element 동시 제거 |
| Module boundary | 위반 | engine/memory/ui 분리 |
| templateVersion | 누락 | 도입 (v1 = 12 sections) |
| 측정 fixture | vapor | LLM-as-judge + golden quiz set |
| Devil's advocate | 부재 | §1.2 |
| Risk R9-R12 | 누락 | 추가 |
| Codex 사실 | 부정확 | 차용 0 명시 + footnote |
| Copilot 사실 | 부정확 (compact == checkpoint) | 정정 (분리 mechanism) |
| Gemini 임계 | 70% (outdated) | 50% (current) |
| OpenCode SUMMARY 헤더 | 6 | 7 (정확) |
| stamping 라벨 | OpenCode 인용 (오류) | "part marking" (자체) |

---

**End of v2 draft**.
