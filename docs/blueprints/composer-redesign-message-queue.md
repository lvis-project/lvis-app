# Composer Redesign + Message Queue System

**Status**: Approved spec, implementation in progress
**Owner**: ken
**Last updated**: 2026-05-14

## Goal

채팅영역 입력 부 (composer) 를 사용자가 정의한 v6 layout 으로 재정비하고, 동시에 LLM busy 도중 사용자 입력을 큐잉/주입할 수 있는 **메시지 큐 시스템** 을 도입한다.

기존 문제:
- composer textarea 가 과도하게 큼 (multi-line 큰 박스)
- input-bar 안에 SEND/GUIDE/Stop 3 개 버튼이 동시 노출 → 시각 피로 + 정보 위계 불명확
- 단축키 hint 가 placeholder 안에만 존재 (학습 보조 X)
- LLM 응답 도중 사용자가 추가 메시지 보낼 통일된 경로 없음 (현재는 ApprovalQueueStatus floating 만)
- PermissionModeBadge / DeferredApprovalChip 의 위치가 사용자 인지 밖

## Non-goals

- ScrollArea / ReasoningCard / message rendering 변경 X
- LLM provider abstraction 변경 X
- 권한 시스템 (PermissionMode) 자체 변경 X — 위치만 이동
- Plugin SDK 변경 X — host-only 작업

## Mockup

[composer-redesign-mockup.html](./composer-redesign-mockup.html) 참조. 3 시나리오 (idle / LLM busy / 최대 노출) 와 2-row layout (TOP=환경, BOTTOM=Turn) 분리.

## Layout 명세 (v6)

위→아래 vertical stack:

```
ScrollArea (messages + ReasoningCard inline) — status 는 여기서 표시
  ↓
SessionTodoPanel (warning 색, 기존 유지)
  ↓
MessageQueuePanel (info 색, 신규)
  ↓
TOP ROW (환경 컨트롤 — 기존 InputActionBar 위치)
  좌: [🔴 알림] [/ 명령어] [⊞ 플러그인]
  우: [📎 첨부] [● 권한] [승인 N] [👤 페르소나] [☐ Thinking]
  ↑               └── PermissionModeBadge + DeferredApprovalChip (NEW 위치)
  ↓
MIDDLE — Composer (textarea ONLY)
  min-height: 2.6em (~2줄), max-height: 9em (~6줄 후 scroll)
  버튼 0개 (모두 BOTTOM 으로 이전)
  ↓
BOTTOM ROW (Turn 컨트롤, 2 cluster — NEW)
  좌 (info, grow): [○ TokenRing $] [? 가이드 ⌘K] [⇧⏎ 줄바꿈] [⌘⏎ 즉시]
  우 (actions):    [esc 취소] [↑ 전송 / 메시지 큐에 추가 ⏎]
```

### 의미 분리

- **TOP ROW = 환경 컨트롤**: turn 종료 후에도 유지되는 설정 (권한/페르소나/Thinking)
- **BOTTOM ROW = Turn 컨트롤**: 현재 turn 종속 상태/액션 (TokenRing/취소/전송)
- **input-bar = 순수 입력 영역**: 사용자 visual frame ("내가 타이핑하는 박스") 과 textarea DOM 1:1

### 색상 분리

- **warning** (`#f0b042`) — SessionTodoPanel + PermissionModeBadge
- **info** (`#4aa9e8`) — MessageQueuePanel + DeferredApprovalChip (큐 권한 승인)
- **accent** (`#6c5ce7`) — Send 버튼 + 메시지 큐 선택 항목 + ⌘⏎ 즉시
- **soft-danger** (`#e57373`) — esc 취소 버튼

## 메시지 큐 시맨틱

**핵심 개념**: 메시지 큐는 **TODO 가 아니다**. 완료/진행중/대기 단계 X. 단순 주입 후보 풀.

### 3 가지 LLM-busy 상태별 동작

1. **자연 인입** (자동, 단축키 없음)
   - LLM 이 assistant 발화 + tool 사용 후 다음 assistant turn 시작 직전 brake-point 에 도달
   - 큐 전체 가 한 덩어리 user message 로 inject (포맷: `"사용자가 다음 항목을 추가 요청했습니다:\n- a\n- b"` wrap, 1 항목일 땐 wrap 생략)
   - inject 후 큐 즉시 비워짐
   - **Brake-point 정의**: tool result 도착 직후 = 다음 assistant 호출 직전 (host post-tool-hook 위치)

2. **즉시 주입 (인터럽트)** (`⌘⏎` 또는 행별 [↑ 즉시])
   - LLM abort + 큐의 선택 항목 + 현재 textarea 입력 → 즉시 user message inject
   - 미선택 항목은 큐에 잔존 (다음 brake-point 에 자연 인입)
   - 빈 큐 + ⌘⏎ = 현재 입력만 즉시 주입 (LLM abort 후 새 turn)

3. **취소** (`ESC` 또는 [esc 취소] 버튼)
   - LLM abort. 큐는 보존
   - 아무 메시지도 inject 안 함
   - **TurnStatusStrip 의 [⏹ 정지] = ESC = [esc 취소]** 동일 액션 (UI 명칭만 통합)

### 큐 항목 액션

- **체크박스 클릭**: 선택 토글 (⌘⏎ 대상 지정)
- **[↑ 즉시] 버튼** (행별, 마우스 only): 그 1 개만 즉시 주입. 다른 큐 항목 잔존
- **[✕] 버튼** (행별, 마우스 only): 해당 항목만 큐에서 제거

### 큐 비우기 시점

- 자연 인입 시: 전체 비움
- ⌘⏎ 인터럽트: 선택 항목만 비움 (미선택 잔존)
- 행별 [↑ 즉시]: 그 1 개만 비움
- LLM turn 자체 종료 시 (응답 완료 + idle 복귀): **큐 자동 비움** (다음 turn 으로 이월 X)

## 단축키 매핑

| 키 | idle | LLM busy |
|---|---|---|
| `⏎` Enter | 전송 → LLM 직행 | 메시지 큐에 추가 |
| `⌘⏎` Cmd+Enter | (동작 동일 — 전송) | 즉시 주입 (LLM abort + 선택+입력 inject) |
| `⇧⏎` Shift+Enter | 줄바꿈 | 줄바꿈 |
| `ESC` | (모달 닫기 또는 무동작) | LLM 취소 (큐 보존) |
| `⌘K` | 가이드 열기 | 가이드 열기 |

### 단축키 hint 표시 위치 (locality)

| 키 | 표시 위치 | 표시 형식 | 조건 |
|---|---|---|---|
| `⏎` | Send 버튼 안 | `↑ 전송 ⏎` / `↑ 메시지 큐에 추가 ⏎` | 항상 |
| `⇧⏎` | BOTTOM ROW info cluster | `⇧⏎ 줄바꿈` | 항상 |
| `⌘⏎` | BOTTOM ROW info cluster (⇧⏎ 옆) | `⌘⏎ 즉시` | LLM busy 시만 |
| `⌘K` | 가이드 ghost button 안 | `? 가이드 ⌘K` | 항상 |
| `ESC` | actions cluster 의 [esc 취소] 버튼 라벨 | `esc 취소` | LLM busy 시만 |

### ESC 우선순위

1. 모달 (Dialog) 열려 있으면 → 모달 닫기
2. 메시지 큐에 선택된 항목 있으면 → 선택 해제 만 (LLM 안 건드림)
3. LLM busy 면 → LLM abort (큐 보존)
4. idle 이면 → 무동작

## 자동 주입 prompt 포맷

큐 자동 인입 시 user message 1 개로 합치는 방식:

- **2+ 항목**: `"사용자가 다음 항목을 추가 요청했습니다:\n- {item1}\n- {item2}\n..."`
- **1 항목**: 항목 자체를 그대로 user message 로 (wrap 없음)

이유:
- 모든 vendor (Claude/OpenAI/Gemini) 호환 — OpenAI 의 연속 user role 제약 회피
- LLM 이 "큐에서 자동 인입된 추가 지시" 라는 메타 정보 명시적으로 인식
- 1 항목 wrap 생략으로 어색함 회피

## 컴포넌트 매핑

### 신규

| 파일 | 역할 |
|---|---|
| `src/state/message-queue.ts` | MessageQueue store class + types. add/remove/toggleSelect/sendNow/injectAll/injectSelected/clear |
| `src/ui/renderer/components/MessageQueuePanel.tsx` | 큐 list UI (SessionTodoPanel 패턴) |
| `src/ui/renderer/components/BottomActionRow.tsx` | Composer 하단 row (TokenRing + 가이드 + hints + 취소 + Send) |
| `src/engine/__tests__/message-queue.test.ts` | store 단위 테스트 |

### 수정

| 파일 | 변경 |
|---|---|
| `src/ui/renderer/ChatView.tsx` | input-cluster 에 MessageQueuePanel 추가 (SessionTodoPanel 다음) |
| `src/ui/renderer/components/Composer.tsx` | input-bar = textarea only, footer (TokenRing/PermissionModeBadge) → BottomActionRow 로 이전, min/max-height 조정 |
| `src/ui/renderer/components/InputActionBar.tsx` | trailing 에 PermissionModeBadge + DeferredApprovalChip 추가 (📎 와 페르소나 사이) |
| `src/engine/conversation-loop.ts` | tool-result 후 brake-point hook 에서 message-queue.injectAll() 호출 |
| `src/ui/renderer/hooks/use-keyboard-shortcuts.ts` (신규 가능) | ⌘⏎ / ESC / ⌘K 통합 매핑 |

### 제거

| 파일 / 영역 | 이유 |
|---|---|
| `src/ui/renderer/components/ApprovalQueueStatus.tsx` (floating) | 메시지 큐 in-flow 패널이 대체 |

## 구현 단계 (PR 분할)

| Stage | PR | 파일 | 검증 |
|---|---|---|---|
| 1 | docs | 본 문서 + mockup HTML | review only |
| 2 | feat | message-queue store + types + tests | vitest |
| 3 | feat | MessageQueuePanel + ChatView mount | vitest + visual smoke |
| 4 | refactor | Composer textarea-only + BottomActionRow + InputActionBar perm/approval | vitest + Playwright |
| 5 | feat | conversation-loop brake-point hook + keyboard shortcuts | vitest + Playwright e2e |
| 6 | test | Playwright e2e for all scenarios (idle / busy / queue inject / interrupt / cancel) | green CI |

각 stage 가 독립적으로 머지 가능 — 머지 시 즉시 main rebase 후 다음 stage 시작 (PR 머지 전 main 최신 동기화 룰 준수).

## 회귀 위험 + 완화

| 위험 | 완화 |
|---|---|
| 기존 사용자 muscle memory (SEND 위치) | 첫 진입 시 1 회 onboarding tooltip ("입력 영역이 정리되었습니다") — Stage 6 e2e 가 covered |
| 큐 잔존으로 다음 turn 에 의도치 않은 inject | turn 종료 시 자동 비우기 (위 "큐 비우기 시점" 참조) |
| 모바일 / 좁은 화면 wrap 깨짐 | BOTTOM ROW info cluster 가 먼저 wrap (actions 는 한 줄 유지) — flex-wrap CSS 로 |
| ESC 가 기존 모달 닫기와 경합 | ESC 우선순위 1=모달, 2=큐 선택 해제, 3=LLM 취소 |
| Plugin 이 메시지 큐 직접 read/write 시도 | host API 미노출. 큐 = host-only state. plugin 은 hostApi.cancel() 정도만 (있다면) |

## Out of scope (별도 PR)

- 큐 항목 drag-and-drop 순서 변경
- 큐 항목 편집 (현재는 ✕ 후 재입력만)
- 큐 항목 자동 만료 (e.g. 5 분 후 비움)
- 큐 메모리 영속화 (현재는 in-memory only — turn 끝나면 비움이라 무관)
- 모바일 전용 단축키 대체 (현재는 desktop muscle memory 가정)

## 의문 / 결정 보류 (구현 중 결정)

1. **전송 직후 윈도우의 client-side abort vs server abort**: ESC 가 client 단에서 즉시 abort 하면 모델 도달 전 무효화 가능. 서버 응답 시작 후엔 무조건 server abort. 구현 시 두 케이스를 동일 흐름 (`ESC = abort current turn`) 으로 통합 시도 — 사용자 mental model 단순화.
2. **brake-point 의 정확한 코드 위치**: conversation-loop 의 어느 hook 에 끼워 넣을지 — 후보: tool result 도착 직후 post-tool-hook, 또는 next-assistant-call 직전 messages 배열 build 단계. 둘 다 같은 effect 라 implementation cleanest 한 쪽으로.
3. **inject 시 Thinking toggle 동기화**: 큐 자동 인입 시 Thinking toggle 의 현재 값을 sticky 로 적용? 아니면 큐 추가 시점의 toggle 값을 기억? — 현재는 인입 시점 값으로 가정.
