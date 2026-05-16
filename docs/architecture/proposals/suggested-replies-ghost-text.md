# Suggested Replies — Ghost Text + Tab Fill

**Status**: Proposal (2026-05-16)
**Scope**: lvis-app renderer + prompts + engine
**Reference**: architecture.md §4.5 (Conversation Query Loop), §12 (UI)

---

## 1. Goal

AI 응답을 받은 직후, 사용자가 다음 메시지로 자연스럽게 이어 입력할
수 있도록 **chat composer 인풋 박스에 추천 답변 1개를 ghost text 로**
표시한다. 사용자는 `Tab` 한 번으로 그 추천을 인풋 박스에 채워 넣고,
필요하면 그대로 보낼 수 있다.

추천 후보가 2~3개일 때는 인풋 박스 **바로 위에 chip row** 를 띄워
대체 후보를 노출한다 (iOS QuickType 키보드 스타일).

## 2. 핵심 결정 사항

| 항목 | 결정 | 근거 |
|---|---|---|
| **Trigger** | 모든 turn 마다 다음 user message 예측 | AI 가 질문을 던진 경우 외에도, 사용자가 어떻게 follow-up 할지 가이드가 필요한 케이스가 많음 (e.g. 명령 실행 결과 후 "성공", "다음 단계" 등). |
| **Source** | 같은 turn LLM 응답 안에 `<suggested_replies>` 포함 | 별도 LLM 호출 → 비용 + latency 부담. Same-turn embedding 은 추가 호출 0. |
| **UI 표시** | 인풋 박스 내 best 1개 ghost text + 위 chip row (대체 2개) | Ghost text 의 single-suggestion 메타포 유지. 다중은 chip 으로 분리. |
| **키보드** | `Tab` = best 채우기, `↑/↓` = chip cycle, `Esc` = 추천 dismiss | Tab 의 universal expectation 유지. cycle 은 별도 키. |

## 3. UX Mockup

```
                                           ← chip row (대체 후보)
 [~/.lvis/audit.log]  [전부 취소]
┌──────────────────────────────────┐
│ ~/.lvis/cache       ← Tab to fill│       ← ghost text (best 추천)
└──────────────────────────────────┘
```

상태별 동작:
- 추천 0개 → chip row + ghost text 모두 hide. 기본 placeholder ("메시지 입력…") 표시.
- 추천 1개 → ghost text 만. chip row hide.
- 추천 2~3개 → ghost text + chip row (best 제외 나머지 1~2개).
- 사용자가 1자 이상 입력 시작 → ghost text + chip row 즉시 hide (typing 우선).
- AI 가 새 turn 응답 도착 → 직전 추천 폐기, 새 추천으로 교체.

## 4. LLM Contract

### 4.1 System prompt patch

`system-prompt-builder.ts` 의 base system prompt 끝에 추가:

```
## Suggested Replies

응답 본문 마지막에 별도 블록으로 사용자가 가장 자연스럽게 이어
입력할 짧은 답변 후보를 1~3개 제시한다. 형식은 반드시 다음과 같다:

<suggested_replies>
- {text}
- {text}
- {text}
</suggested_replies>

규칙:
- 응답 본문이 단순 확인성("완료했습니다") 외에 사용자 행동을 유도할
  여지가 없으면 블록 자체를 생략한다.
- 각 후보는 25자 이하의 한국어 (사용자 prior turn 언어와 일치).
- Tool 호출이 진행 중이거나, 응답이 streaming 중 cut-off 된 경우 생략.
- 후보 간 의미가 서로 직교적이어야 한다 ("예/아니오" 둘 다는 OK,
  "예/네/그래" 같은 동의어 묶음은 금지).
```

### 4.2 Provider-agnostic 검증

모든 vendor (Claude / GPT / Gemini / Azure-Foundry) 가 이 형식을 동일하게
따르는지 검증하는 contract test 1개를 추가한다:

```ts
// src/engine/__tests__/suggested-replies-contract.test.ts
it.each(vendorsUnderTest)("%s emits <suggested_replies> when prompted", ...)
```

Vendor 별 differential behavior 가 발견되면 system prompt 를
vendor-conditional 로 분기한다 (PR-A 의 follow-up issue).

## 5. Streaming + Parsing

### 5.1 Streaming buffer 룰

- LLM 응답 stream 중 `<suggested_replies>` 토큰을 만나면 그 시점부터의
  바이트는 **사용자에게 노출하지 않고** 별도 buffer 로 분리한다.
- 분리 시점 판정: streaming chunk concatenation 후 `<sugg` 접두사가
  나타난 직후 (incremental matcher). False match 방지를 위해 `<sugg`
  이후 첫 줄바꿈까지를 lookahead 로 확인.
- Stream 종료 (turn complete) 직후 buffer 를 parse → `parseSuggestedReplies(buffer): string[]`.
- Parse 실패 시 (malformed XML, 0 항목 등) → 추천 0개로 처리, 사용자
  에러 노출 없음.

### 5.2 Parser

```ts
function parseSuggestedReplies(raw: string): string[] {
  const match = raw.match(/<suggested_replies>([\s\S]*?)<\/suggested_replies>/);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^[\s\-•*]+/, "").trim())
    .filter((l) => l.length > 0 && l.length <= 50)
    .slice(0, 3);
}
```

### 5.3 Backwards compatibility

기존 turn 완료 흐름 (`post-turn-hook-chain`) 에 영향 0. Parse 결과를
새 `SuggestedRepliesStore` (단순 module-level state + subscriber) 에
push 하고 Composer 가 subscribe.

## 6. Renderer Architecture

### 6.1 신규 파일

- `src/ui/renderer/hooks/use-suggested-replies.ts`
  — `useSyncExternalStore` 로 store subscribe.
  — returns `{ best: string | null; alternates: string[]; dismiss(): void; accept(text: string): void }`.

- `src/ui/renderer/components/SuggestedRepliesGhost.tsx`
  — ghost text overlay. Composer 의 textarea 와 동일한 font / line-height
    / padding 으로 absolute positioning. value 가 비어있을 때만 visible.

- `src/ui/renderer/components/SuggestedRepliesChipRow.tsx`
  — chip row. Composer 바로 위 inline element. focus management 는
    textarea 의 `aria-controls` 로 연결.

### 6.2 Composer 변경

`src/ui/renderer/components/Composer.tsx`:
1. props 에 `suggestedReplies?: { best: string | null; alternates: string[] }` 추가.
2. textarea wrapper 에 `<SuggestedRepliesGhost />` 자식 추가, value 가 빈 문자열일 때만 렌더.
3. textarea 위에 `<SuggestedRepliesChipRow />` 자식 (alternates.length > 0).
4. `keydown` handler 확장:
   - `Tab` (no shift) + value 비어있음 + best != null → preventDefault + insert best.
   - `ArrowUp` / `ArrowDown` + chip row visible → focus 이동 (chip row 안에서 cycle).
   - `Escape` + (best || alternates.length > 0) → `dismiss()`.

### 6.3 ChatView 변경

`src/ui/renderer/ChatView.tsx`:
- `const replies = useSuggestedReplies()`.
- Composer 에 `suggestedReplies={replies}` 전달.
- 추가 effect 없음 (store 가 turn 완료 시 self-update).

## 7. Engine 연동

### 7.1 conversation-loop.ts

Turn 종료 (final message persisted) 직후, `parseSuggestedReplies(finalMessage.content)` 호출 → store push.

### 7.2 streaming 중간 노출 방지

`auto-compact.ts` 의 token-aware truncation 과 동일한 layer 에서 strip.
Renderer 의 `useChatState` `__lvisChatStream._emit` seam 에는 strip 후
buffer 만 전달.

## 8. Edge Cases

| Case | 동작 |
|---|---|
| Tool call 진행 중 turn | 추천 0개 (system prompt 룰). |
| Tool call interleaved final message | Final message 만 parse. |
| Stream error / abort | 추천 0개 (parse buffer 비어있음). |
| Multi-language (영어 응답) | LLM 이 사용자 prior turn 언어를 follow. 추가 처리 0. |
| 첫 turn (이전 user message 0개) | 빈 인풋 박스 → 추천 0개 (turn 종료 후에만 활성). |
| 사용자 typing 중 새 turn 도착 | 추천 hide. 사용자가 인풋 클리어 → 자동 reappear. |
| Composer 가 focus 아닐 때 | Ghost text + chip row 모두 visible 유지 (사용자가 보고 의도적으로 focus 할 수 있도록). |
| ImePreedit (한글 조합) 중 | Ghost text hide (composition 끝나면 reappear). |
| 추천이 사용자 입력 prefix 와 충돌 | 사용자가 1자 이상 입력하면 추천 hide. |

## 9. Implementation Plan (PR 분할)

| PR | Scope | Risk |
|---|---|---|
| **PR-A** | System prompt patch + parser + store + vendor contract test | 낮음 — 기존 turn flow 무변경. 추천이 안 떠도 회귀 0. |
| **PR-B** | SuggestedRepliesGhost + ChipRow 컴포넌트 + Composer 통합 + 키보드 handler | 중간 — Composer 회귀 위험. e2e 필수. |
| **PR-C** | Streaming buffer (사용자 노출 방지 strip) | 중간 — stream 처리 정밀. |
| **PR-D** | UX 폴리쉬 (chip row animation, dismiss memory, telemetry) | 낮음 — incremental. |

각 PR 은 단독 머지 가능. PR-A 머지만 해도 LLM 응답에 `<suggested_replies>`
가 들어오기 시작하지만 (사용자에게는 그대로 노출되어 일시적 UX 회귀) —
따라서 **PR-A 와 PR-C 는 같은 릴리스 사이클** 안에서 머지.

권장 순서: PR-A → PR-C → PR-B → PR-D.

## 10. Open Questions

- **추천 noisy 측정**: 사용자가 ghost text 를 무시하고 자기 텍스트 입력하는
  비율이 X% 이상이면 trigger condition 을 좁혀야 함. PR-D 의 telemetry
  에서 accept / dismiss / ignore 카운트 추적 필요.
- **Vendor differential**: GPT 가 `<suggested_replies>` 를 안 따르거나
  malformed 응답을 자주 내면 vendor-specific prompt 분기 필요. PR-A
  의 contract test 결과 보고 결정.
- **Plugin response interception**: plugin 이 직접 final message 를 만들
  수 있는가? 가능하면 plugin SDK 에 추천 emit API 추가 (`hostApi.emitSuggestedReplies(["..."])`).
- **Accessibility**: ghost text 가 screen reader 에 어떻게 노출되는지
  검증. `aria-describedby` 로 연결 필요할 수 있음.
- **Token cost**: same-turn LLM 응답 토큰 ~30~80 추가. 컨텍스트 윈도우
  부담은 미미하지만 비용 다소 증가. PR-D 에서 user-toggleable 옵션화
  여부 결정.
