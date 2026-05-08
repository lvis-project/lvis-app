# Infinity Session Redesign v1 — 3-Layer Compact + Same-Session Checkpoint

**Status**: 🟡 DRAFT (review pending)
**Date**: 2026-05-08
**Architecture ref**: `lvis-app/docs/architecture/architecture.md` v4 §4.5 / §5
**Supersedes**: `continuous-chat-rotation-closure-report.md` (3-tier rotation 동작 일부 폐지)
**Related memory**:
- `reference_lvis_cleanup_pipeline.md` (5-tier 현황)
- `reference_token_session_4source.md` (provider 별 usage 의미)
- `project_2026-05-07_cleanup_diagnostic.md` (reactive-compact mid-loop 의심)

---

## 1. Goal — 인피니티 세션 정의

> 사용자가 **세션을 명시적으로 종료하지 않은 채** 며칠~몇 주 단위로 같은 sessionId 안에서 대화를 이어가도, *대화 품질 단조 비감소* + *주제 일관성 유지* + *임의 시점 회귀 가능* 을 만족시키는 단일 세션 모델.

### 1.1 측정 가능한 성공 지표
| 지표 | 목표 | 측정 방법 |
|---|---|---|
| **Mid-loop reactive compact 발생률** | 0/turn (영구 제거) | 진단 로그 `queryLoop: context_error caught` 발생 횟수 |
| **압축 후 LLM empty-response 비율** | < 0.1 % | `reactive-compact retry returned EMPTY` 카운트 / 전체 turn |
| **세션 fork (sessionId 변경) 빈도** | 0 (사용자 명시 fork 만) | sessionId 분기 발생 횟수 |
| **압축 후 Goal/Decisions 보존률** | ≥ 95 % | (post-compact 에서 LLM 이 prior decisions 회상하는 회귀 테스트) |
| **세션 길이 한도** | 무제한 | 7일 stress test, 1000+ turn 통과 |

### 1.2 Non-goals
- *latent-preserving handoff* (Codex `encrypted_content`) — Anthropic/Gemini API 미지원, 구현 불가
- 초장기(月 단위) full-text 회귀 — checkpoint preview 로 충분
- 다중 device cross-session 동기화 — 별도 PR

---

## 2. 현재 구조의 핵심 문제 (요약)

| 문제 | 증거 |
|---|---|
| **5 메커니즘 중복** | `microcompact` + `auto-compact` + `reactive-compact` + rotation Tier 1/2/3 — 트리거가 겹치고 의미가 분기 |
| **`cumulativeUsage` lifetime 누적 의미** | `conversation-loop.ts:1135` 매 라운드 단조 증가, auto-compact 후 미리셋. shouldCompact 가 *현재 컨텍스트* 가 아닌 *세션 누적* 측정 |
| **mid-loop reactive compact 위험** | `conversation-loop.ts:1027,1356` provider error 후 history mutate → LLM tool-chain 손실 → empty response (silent failure) |
| **dead state**: `meta.carryover`, `meta.compactBoundary` 추출만 하고 system prompt 어디에서도 재주입 없음 | `grep -rn meta\.carryover src/prompts src/memory` → 0 hit |
| **rotation = sessionId fork** | child session 으로 분기 → 사용자 입장 "이전 대화 어디 갔나" 의문 |

상세 매핑: `reference_lvis_cleanup_pipeline.md` 및 본 세션의 prior analysis.

---

## 3. References — 4 개 레퍼런스 합성

| 차원 | OpenCode | Codex CLI (GPT-5.3) | Gemini CLI | Copilot Chat |
|---|---|---|---|---|
| 트리거 | 끝 40K preserve + ≥20K free 가능 시 | ~83.5% (167K/200K) | 70% (configurable) | 모델 한도 근접 자동 |
| 1차 시도 | "stamping" — `compacted=ts` 마킹, 물리 삭제 X | structured session memory 조회 (대부분 LLM 미사용) | head/tail 분할, head 만 LLM 요약 | 자동 background |
| 2차 시도 | SUMMARY_TEMPLATE: Goal/Constraints/Progress/Decisions/NextSteps/Critical | `POST /v1/responses/compact` opaque `encrypted_content` | XML 스냅숏: goal/knowledge/fs state/plan | LLM 요약 |
| 보존 | 끝 40K verbatim, skill-tool 출력 절대 prune 금지 | 압축 후 lead-in + 최근 5 파일 자동 재로드 (50K 예산) | "Reverse Token Budget": 최근 verbatim, 오래된 30줄 truncate | preserve recent |
| 클러스터링 | 시간 기반 | 시간 기반 | **Union-Find episode** (실험) | 시간 기반 |
| 체크포인트 ↔ compact | 분리 | 분리 | 분리 | **동일 사건 — compact 마다 numbered checkpoint** |

LVIS 차용 결정:
- **"stamping" 패턴** (OpenCode) — 물리 삭제 대신 마킹, 직렬화 시점에 stub 화
- **SUMMARY_TEMPLATE** (OpenCode + Codex 합성) — Layer 2 의 LLM 출력 형태
- **70% 임계** (Gemini) — pre-flight 가드 임계 (200K 모델 기준; Cline 룰로 모델별 분기)
- **compact == checkpoint** (Copilot) — 같은 sessionId 안에서 numbered 사슬

---

## 4. Architecture — 3-Layer Model

### 4.1 Layer 0: Pre-flight Guard (per-round, no LLM)

**위치**: `engine/conversation-loop.ts:queryLoop` 라운드 진입 직전 (현 line 1006 `repairToolPairInvariant` 직후).

**알고리즘**:
```
estimated = estimateMessagesTokens(history)
usable    = getModelUsableContext(provider, model)   # Cline buffer 적용
if estimated >= usable * THRESHOLD_PREFLIGHT:        # 70% (모델별 표 §6)
    runLayer2Compact(reason="preflight")
    # post-compact 후 estimated 재계산
```

**효과**:
- mid-loop reactive compact 영구 제거 (도달 전 사전 압축)
- provider context_error 분기 코드 *전체 삭제* (`conversation-loop.ts:1027~1102`)

**불변식**:
- Layer 0 는 LLM 호출 없음 — 토큰 추정만
- estimateTokens 한국어 underestimate 보정: `estimateTokens()` 의 chars/4 공식에 한글 비율 가중치 추가 (별도 §6 표)

### 4.2 Layer 1: Stamp (lazy, idempotent, no LLM)

**현 microcompact 대체**.

**위치**: `auto-compact.ts:stampStaleToolResults` (rename from `microcompactMessages`).

**변경점**:
- `meta.stripped: true` + content 교체 → `meta.compactedAt: ts` 만 마킹, content 보존
- 직렬화 단계 (provider 호출 직전) 에서 `compactedAt` 마킹된 tool_result 만 stub 으로 교체하여 wire format 생성
- 원본 history 는 영구 보존 → 사용자 UI / checkpoint preview / 회귀 디버깅 가능
- stub 임계: tool_result 길이 ≥ 200 자 인 경우만 stub (OpenCode 패턴)
- 끝 N 개 tool_result preserve — N = 8 (현 4 → 2배)

**불변식**:
- skill-route 도구 결과 + `meta.lock: true` 있는 메시지는 stamp 면제
- toolUseId 절대 변경 X
- idempotent — 이미 stamped 면 no-op

### 4.3 Layer 2: Structured Compact (LLM, threshold 도달 시)

**현 auto-compact + reactive compact 통합 대체**.

**위치**: `engine/structured-compact.ts` (신규 파일).

**알고리즘**:
```
1. messagesToCompact = history.slice(0, len - PRESERVE_RECENT_TOKENS_BUDGET)
2. messagesToPreserve = history.slice(len - PRESERVE_RECENT_TOKENS_BUDGET)
3. summary = await callLLM(SUMMARY_TEMPLATE_PROMPT, messagesToCompact)
4. boundaryMessage = {role: "user", content: renderTemplate(summary), meta: {...}}
5. ackMessage      = {role: "assistant", content: POST_COMPACT_ACK}
6. newHistory = [boundaryMessage, ackMessage, ...messagesToPreserve]
7. cumulativeUsage = estimateMessagesTokens(newHistory)   # 의미 정합 — 항상 "현재" 측정
8. createCheckpoint(boundaryMessage, summary, ts)         # Layer 3 와 통합
```

**핵심 변경 vs 현재**:
- LLM-free extractive (`auto-compact.ts:545`) → LLM-based structured (별도 1회 호출)
- summary 형식 → `SUMMARY_TEMPLATE` (§5) 강제
- `cumulativeUsage` reset (현재 누락 — 본 redesign 의 핵심 정정)
- `meta.carryover` 제거 (dead) — SUMMARY_TEMPLATE 의 본문에 자연 통합

**Boundary 메시지 보존 contract**:
- `meta.compactBoundary: true`
- `meta.compactNum: N` (몇 번째 compact 인지)
- `meta.summaryStructured: ParsedSummary` (Goal/Constraints/Progress/...)
- `meta.checkpointId: uuid` (Layer 3 anchor)
- session-store 직렬화 시 meta 필드 모두 보존되어야 함 (현재 schema 가 이미 meta-passthrough — 회귀 테스트 추가)

### 4.4 Layer 3: Checkpoint (same sessionId, numbered chain)

**현 3-tier rotation fork 동작 폐지**, **북마크 + revert UI 만 유지**.

**위치**: `engine/checkpoint-chain.ts` (신규).

**Trigger**:
- Layer 2 가 일어날 때 자동 (compact == checkpoint)
- LLM `[checkpoint]` 마커 (semantic-llm 다운그레이드: rotation X, bookmark only)
- 사용자 수동: `/checkpoint <label>` 커맨드
- 24h+ 휴면 후 첫 turn (day-boundary 자동 북마크)

**Storage** (`~/.lvis/sessions/<sessionId>.checkpoints.json`):
```json
{
  "sessionId": "abc-123",
  "checkpoints": [
    {
      "id": "ckpt-uuid",
      "num": 1,
      "createdAt": "2026-05-08T08:00:00.000Z",
      "trigger": "auto-compact" | "semantic-llm" | "manual" | "day-boundary",
      "messageIndexAtCreation": 47,
      "summaryStructured": { /* SUMMARY_TEMPLATE 파싱 결과 */ },
      "label": "auth refactor done"        // optional 사용자 라벨
    }
  ]
}
```

**Revert UI**:
- 클릭 시 *현재 sessionId 그대로*, history 를 `messageIndexAtCreation` 시점까지 슬라이스 view 모드 진입
- 사용자가 "여기서부터 다시" 선택 시 그 시점의 history 만 LLM 에 보내고 새 turn 작성 (sessionId 불변)
- 즉 Copilot 의 "restore checkpoint" 동등 패턴

**핵심 변경 vs 현재**:
- `rotateActive()` (`conversation-loop.ts:1683`) 의 `sessionId = childSessionId` 줄 *제거*
- `createChildSession()` 호출 제거
- `lastCheckpointMessageIndex` → `checkpoints[N].messageIndexAtCreation` 로 이주

---

## 5. SUMMARY_TEMPLATE — Layer 2 의 핵심 산출물

### 5.1 LLM 프롬프트

```
당신은 대화 상태 관리자입니다. 아래 대화를 다음 구조로 요약하세요.
정보 손실 최소화가 최우선이며, 추측·창작 금지. 본문에 없는 사실은 적지 마세요.

# Session State as of {{timestamp}} (compact #{{N}})

## Goal
사용자의 *현재* 최상위 목표 1-3 줄. 첫 메시지 + 후속 명시적 변경을 누적 반영.

## Active Constraints
명시된 제약 (기술/비즈/시간). "X 사용 금지", deadline, security 룰 등. bullet.

## Progress
- [x] 완료 (≤ 5 항목)
- [-] 진행 중
- [ ] 미시작

## Key Decisions
- decision (이유: why) — 5 개 이내, 최근 우선

## Files Touched
경로:역할:상태 — read/edited/created, 마지막 동작 시점.

## Next Steps
직전 어시스턴트가 명시한 다음 액션. 없으면 "(미정)".

## Critical Context
잃으면 안 되는 것 — secret/ticket/endpoint/규칙. 본문에 명시된 것만.

대화:
{{conversationText}}
```

### 5.2 출력 검증 (parser)

`structured-compact.ts:parseSummary()` — Markdown heading 파싱. 7 개 섹션 모두 존재해야 valid. 누락 시 LLM 1회 재호출 (재시도 1회만).

### 5.3 다음 turn 의 LLM 가시성

Boundary message 가 `role: "user"` 로 들어가므로 LLM 은 이전 자기 발화처럼 받아들임. system prompt 에 추가 주입 *불필요* — 본문 자체가 프롬프트.

---

## 6. Per-Model Thresholds (Cline 룰 + 4 레퍼런스 합성)

| Model context | Usable (Cline buffer) | Layer 0 pre-flight 임계 | Layer 2 budget — preserve recent |
|---|---|---|---|
| 64K | 37K | 60 % (≈ 22K) | 8K |
| 128K | 98K | 65 % (≈ 64K) | 16K |
| 200K | 160K | 70 % (≈ 112K) | 32K |
| 1M (beta) | 960K | 75 % (≈ 720K) | 64K |
| Other | max(ctx−40K, 0.8×ctx) | 70 % | 0.1 × usable |

**임계 선정 근거**:
- 작은 모델일수록 단일 tool 라운드의 한계 비중 큼 → 더 보수적 (60%)
- 200K Anthropic 은 Gemini 의 70% 패턴 차용
- 1M 은 압축 비용 vs 정확도 trade-off — 더 늦게 (75%) 트리거

---

## 7. Data Schema Changes

### 7.1 `GenericMessage.meta` 확장
```typescript
meta?: {
  // existing
  compactBoundary?: boolean;
  compactedAt?: string;        // ISO 8601 — Layer 1 stamp 시각
  removedCount?: number;
  // new
  lock?: boolean;              // Layer 1 면제 표시
  compactNum?: number;         // Layer 2 boundary 일 때 #N
  checkpointId?: string;       // Layer 3 anchor
  summaryStructured?: ParsedSummary;
  // removed
  // carryover?: ConversationCarryover;   // dead state, 삭제
  // stripped?: boolean;                   // Layer 1 stamping 으로 의미 통합
};
```

### 7.2 신규 파일
- `~/.lvis/sessions/<sessionId>.checkpoints.json` — Layer 3 인덱스
- 마이그레이션: 기존 sessions 는 빈 checkpoints 배열로 시작

### 7.3 제거되는 코드
| 코드 | 위치 | 이유 |
|---|---|---|
| `extractCarryover()` + `meta.carryover` | `auto-compact.ts:455~514` + line 264 | dead state |
| `tryReactiveCompact()` | `conversation-loop.ts:1356~1388` | Layer 0 가 사전 예방 |
| context_error 분기 | `conversation-loop.ts:1027~1102` | 위와 동일 |
| `createChildSession()` 호출 | `conversation-loop.ts:1608` | sessionId fork 폐지 |
| `rotateActive()` 의 sessionId 변경 | `conversation-loop.ts:1684` | 같은 sessionId 유지 |
| 3-tier `decideRotation()` 의 hard-token | `auto-compact.ts:110` | Layer 2 가 흡수 |
| extractive `generateSummary()` (private) | `auto-compact.ts:545` | LLM-based 로 대체 |

### 7.4 Rename
- `summary-generator.ts:generateSummary` → `generateRotationSummary` 더 이상 회전 안 하므로 → `generateStructuredSummary`
- `microcompactMessages` → `stampStaleToolResults`
- `compactMessages` (public, auto-compact.ts) → `compactWithStructuredSummary` (LLM 기반으로 의미 변경)

---

## 8. Migration — 3 PR Roadmap

### PR-1: Cleanup + Rename (low risk)
- dead state 제거: `extractCarryover` + `meta.carryover` + 그 테스트
- rename: `summary-generator.ts:generateSummary` → `generateStructuredSummary`
- microcompact 의 200자 threshold + preserveRecentToolResults 4→8
- preserveRecentMessages 4→12
- Layer 1 의 stamping 패턴 도입 (content 보존, 직렬화 시 stub)

**검증**: 기존 unit/integration test 회귀 0 + microcompact 새 테스트 (size threshold, lock 메시지 면제)

### PR-2: Layer 0 + Layer 2 도입 (medium risk)
- `engine/structured-compact.ts` 신규 — LLM call + SUMMARY_TEMPLATE
- `queryLoop` Layer 0 pre-flight guard 추가
- `tryReactiveCompact()` + context_error 분기 *전체 삭제*
- `cumulativeUsage` 의미 변경: Layer 2 후 reset
- Per-model threshold 표 (`shared/context-budget.ts` 확장)

**검증**:
- 회귀: 기존 reactive-compact.test.ts 시나리오 → Layer 0 가 사전 차단함을 확인
- 신규: pre-flight 가드 fixture (60/65/70/75% threshold per model)
- e2e: 200 turn × 평균 1K input 토큰 stress → mid-loop compact 0 회 확인

### PR-3: Layer 3 = same-session checkpoint (medium risk)
- `engine/checkpoint-chain.ts` 신규
- `runRotationCheck()` 폐지 — Layer 2 가 자동 createCheckpoint 호출
- `rotateActive()` 의 sessionId 변경 *제거*
- `createChildSession()` 제거
- UI: CheckpointDivider 의 onRevert 동작 변경 (sessionId 변경 X, view-mode 진입)
- 마이그레이션: 기존 fork-된 child session 들은 그대로 두고 신규 세션 부터 적용

**검증**:
- e2e: 사용자 시나리오 (compact 3회 + revert to checkpoint #2 + 새 turn)
- 회귀: continuous-chat-rotation-closure-report.md 의 incident 시나리오 → 동등 또는 개선

---

## 9. Risks + Mitigations

| 위험 | 영향 | 완화 |
|---|---|---|
| **R1: Layer 2 LLM call 실패** | 압축 못 함 → 다음 라운드 즉시 또 70% 임계 | 1회 재시도 + 실패 시 Layer 1 stamping 강제 (truncate-fallback) |
| **R2: SUMMARY_TEMPLATE 출력 형식 위반** | 다음 turn LLM 이 boundary 인식 못 함 | parser 검증 + 1회 재호출 + 최후 raw 텍스트 그대로 사용 |
| **R3: Layer 0 토큰 추정 부정확** | 한국어 비율 큰 세션에서 늦게 트리거 | per-model 임계 보수적 + 한글 비율 가중치 (estimateTokens 보정) |
| **R4: 같은 sessionId 안 history 무한 성장 (디스크)** | 7일 후 sessions JSONL 수십 MB | Layer 1 stamping 의 "원본 보존" 은 *메모리* 만; 디스크 직렬화는 stub 화. preview 시 lazy-rehydrate 불가능 (의도된 lossy) |
| **R5: revert UI 의 view-mode 와 새 turn 후 forward history 충돌** | 사용자가 과거 시점에서 새 turn → branch 발생 | branch 는 *명시적 fork* 로만 (별도 PR 범위 밖, 현 단계는 "branch 시 자동으로 새 sessionId" 로 단순 처리) |
| **R6: PR-2 의 context_error 분기 삭제 후 어떤 provider 가 새로운 에러 메시지로 한도 초과** | Layer 0 가 못 잡으면 unhandled error | safety net: `isContextLengthError()` 함수는 유지, fail 시 사용자에게 "메시지 길이 초과 — /compact 으로 압축" 안내 |
| **R7: Layer 3 manual `/checkpoint` 커맨드 keyword 충돌** | 기존 `/compact` 와 의미 분리 어려움 | 둘 다 유지 — `/compact` 은 Layer 2 강제 트리거, `/checkpoint <label>` 은 라벨링만 |
| **R8: 기존 fork 된 child session 들의 호환성** | parent-child chain 가시성 깨질 수 있음 | 마이그레이션 코드 없음 — 기존 fork 는 separate sessions 로 그대로 표시. 신규 세션 부터만 same-session 모델 |

---

## 10. Test Plan

### 10.1 Unit
- `structured-compact.test.ts`: SUMMARY_TEMPLATE 출력 → parser 통과 / 형식 위반 → 재시도
- `stamping.test.ts`: idempotent / lock 면제 / 200자 threshold / toolUseId 보존
- `pre-flight-guard.test.ts`: 모델별 임계 / 한글 보정 / cumulativeUsage reset

### 10.2 Integration
- `infinity-session.integration.test.ts`: 100 turn 시뮬레이션 → mid-loop reactive 0 / sessionId 1 / checkpoint chain 자동 생성
- `revert-to-checkpoint.integration.test.ts`: compact 3회 → revert #2 → forward turn → branch 시나리오

### 10.3 E2E (Playwright)
- ChatView 에서 compact 3 회 보이는 CheckpointDivider 클릭 가능
- revert 후 view-mode UI 식별 가능
- "여기서부터 다시" 트리거

### 10.4 Stress
- 7일 / 1000+ turn / 평균 5K input 토큰 → memory + disk + token-budget 안정
- 메트릭: `~/.lvis/audit.jsonl` 분석 — Layer 2 발생률, 평균 freed tokens

---

## 11. Open Questions (사용자 결정 필요)

1. **Q1: SUMMARY_TEMPLATE 의 "Critical Context" 섹션 — LVIS 도메인 specific 항목 추가?**
   - 후보: 활성 plugin 목록, 활성 routine ID, 현재 작업 중 PR 번호, 활성 권한 모드(propose/auto)
   - LVIS 만의 정보 — 사용자 도메인 입력이 가장 가치
2. **Q2: Layer 2 LLM call 의 모델 — 사용자 선택 모델 동일 vs 별도(haiku 등 저렴)?**
   - 별도 모델 → 비용 ↓, vendor mismatch 시 token 추정 어긋날 수 있음
   - 동일 모델 → 비용 ↑ (turn 당 1 회 추가), 일관된 추론 스타일
   - 추천: 사용자 모델과 *같은 vendor* 의 *최저 tier* (Anthropic→Haiku, OpenAI→4o-mini, Gemini→Flash)
3. **Q3: Layer 1 stamping 의 "원본 보존" 범위**
   - 메모리 only (디스크는 stub) — 본 문서 default
   - 디스크도 보존 — preview 정확도 ↑, 디스크 ↑↑↑
4. **Q4: revert-to-checkpoint 후 new turn 시 branch 동작**
   - 자동 새 sessionId fork (current-style)
   - 같은 sessionId 안에서 history append (linear; 사용자가 명시적으로 fork 요청해야 분기)
5. **Q5: per-model 임계값 (§6) 의 보수성**
   - 70 % 가 200K 에 적절한지, 65 % 가 더 안전한지
   - 4 레퍼런스 산술 평균 ≈ 75 %, Hermes 80 %, Gemini 70 %, Codex 83.5 %

---

## 12. Approval Checklist

- [ ] Architect review (architecture v4 §4.5 / §5 정합)
- [ ] Critic review (계획 multi-perspective)
- [ ] Code reviewer (현 구현과의 parity 확인)
- [ ] Document specialist (4 레퍼런스 정확성 cross-check)
- [ ] User decision on §11 Q1-Q5
- [ ] Implementation PR-1 → PR-2 → PR-3 순차 진행

---

**End of v1 draft**.
