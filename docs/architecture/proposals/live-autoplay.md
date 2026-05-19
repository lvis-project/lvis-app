# Live Auto-play — LVIS 가 스스로 1턴 시연

> **Status**: proposal (PR-E — minimal viable + architectural SOT)
> **Owner**: Onboarding / Tutorial track
> **Mockup SOT**: `/tmp/login-lvis/index.html` O-X1 (innovation onboarding cluster)
> **Scope**: Onboarding 의 가장 혁신적 부분 — 사용자 클릭 없이 LVIS 가 *스스로* demo turn 1회를 자동 시연.

---

## 1. Motivation

신규 사용자가 LVIS 의 *진짜 능력* 을 첫 30초 안에 보게 한다.

- "텍스트 가이드" 보다 라이브 시연이 압도적으로 강력 — 사용자는 *읽는 것* 이 아니라 *보는 것* 으로 신뢰함.
- 기존 onboarding (`OnboardingDialog`) 는 API 키 입력/로그인 분기만 처리 → "그래서 *뭘* 할 수 있는데?" 라는 두 번째 질문에 답하지 않음.
- Live Auto-play 는 그 답을 *시각적 1턴 시연* 으로 즉시 제공:
  - 사용자 입력처럼 보이는 type-on
  - 도구 호출 + 자동 승인 (가짜 sandbox)
  - 결과 표시
  - "이런 식이에요. 직접 해보시겠어요?" 핸드오프 카드 + REC 인디케이터

핵심 design tension: **demo 의 trust boundary**. fake sandbox 가 LLM 호출 없이 사전 정의된 결과를 반환하므로, *사용자가 fake 결과를 real 로 오인* 하거나 *후속 LLM 호출이 fake context 를 신뢰* 하는 위험이 있다. 이 문서의 절반은 그 위험에 대한 mitigation 설계.

---

## 2. System diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Onboarding decision (App.tsx)                                   │
│ - settings.features.demoAutoplayEnabled = true                  │
│ - settings.features.onboardingCompleted = false                 │
│ - LVIS_DEMO_VENDOR set                                          │
│         ↓                                                       │
│  ChatView mounts in `demo-autoplay` mode                        │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│ DemoAutoplayBanner (UI)                                         │
│  ┌─ ⏺ REC ───────────────────── "키 잡기 →" ─┐                  │
│  └────────────────────────────────────────────┘                 │
│                                                                 │
│ ChatView body                                                   │
│  ┌─ user message (type-on simulated) ───────────────────────┐   │
│  │ "이번 주 회의록 한꺼번에 정리해줘▍"                     │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌─ tool call card (auto-approved) ─────────────────────────┐   │
│  │ meeting_list · 최근 5일 회의                            │   │
│  │ [데모: 자동 승인 ✓]                                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌─ tool result (fake) ──────────────────────────────────────┐  │
│  │ 📄 3건 발견: Q2 OKR · Sprint 51 · Vendor sync           │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌─ assistant response (type-on simulated) ───────────────────┐ │
│  │ "① Q2 OKR 리뷰 — 매출 92% 달성… ②… ③…▍"                  │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌─ take-over footer ────────────────────────────────────────┐  │
│  │ 👋 이런 식으로 동작해요. 직접 해보시겠어요? [키 잡기 →]    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼ (user types or clicks "키 잡기")
┌─────────────────────────────────────────────────────────────────┐
│ ScriptedTurnEngine.abort()                                      │
│ - clears scripted history entries (memory pollution 방지)       │
│ - flushes pending REC audit entry as "aborted"                  │
│ - ChatView state: demo-autoplay → normal                        │
│ - settings.features.demoAutoplayEnabled = false (one-shot)      │
└─────────────────────────────────────────────────────────────────┘
```

**Hook 위치**: ConversationLoop 의 *바깥쪽* 에서 ChatView 의 stream-event channel 로 *fake* StreamEvent 를 emit. LLM/tool runtime 은 호출되지 않음. fake sandbox 는 ScriptedTurnEngine 내부에 closed loop 으로 존재. → ConversationLoop 의 trust boundary 를 demo 가 *우회* 가 아니라 *대체* 한다.

---

## 3. Contracts

### 3.1 ScriptedTurn

```ts
/** Single autoplay turn — fully self-contained, no LLM/tool runtime touched. */
export interface ScriptedTurn {
  /** Stable id (slug). Loaded from scripts/<id>.json. */
  id: string;
  /** Localized title for REC indicator + audit. */
  titleKo: string;
  /** Simulated user message — emitted with type-on animation. */
  userMessage: string;
  /** Tool call sequence — each call returns a sandboxed fake result. */
  toolCalls: ScriptedToolCall[];
  /** Final assistant response — emitted with type-on animation. */
  assistantResponse: string;
  /** Type-on speed (ms / char). Default 25. */
  typeOnMsPerChar?: number;
}

export interface ScriptedToolCall {
  /** Tool name (must match a real tool name on disk for visual fidelity). */
  toolName: string;
  /** Korean label shown next to the tool name. */
  labelKo: string;
  /** Pre-computed fake result — *string only* (no nested LLM JSON). */
  fakeResultKo: string;
  /** Optional delay before this call fires (ms). Default 600. */
  delayMs?: number;
}
```

**SOT 파일 위치**: `src/engine/demo-autoplay/scripts/*.json`. 본 PR 에는 `meeting-summary-demo.json` 한 개 포함 (mockup O-X1 그대로).

### 3.2 Fake sandbox

```ts
export interface FakeSandbox {
  /**
   * Resolve a scripted tool call → pre-defined result.
   * Throws if the tool name is not in the script's `toolCalls` list.
   * Never calls real plugins, never touches network, never reads ~/.lvis/.
   */
  resolve(call: ScriptedToolCall): Promise<{ ok: true; result: string }>;
}
```

**Invariant**: FakeSandbox 는 *file system / network / plugin runtime / LLM* 어떤 외부 surface 도 건드리지 않는다. 단순 lookup. 이로써 "fake 결과가 real 처럼 보이지만 실제로는 isolated" 이라는 trust boundary 가 코드 수준에서 명시.

### 3.3 ScriptedTurnEngine

```ts
export interface ScriptedTurnEngine {
  start(turn: ScriptedTurn, sink: ScriptedSink): Promise<void>;
  abort(reason: "user-takeover" | "user-input" | "external"): void;
  isRunning(): boolean;
}

export interface ScriptedSink {
  emitUserMessage(text: string, isFinal: boolean): void;
  emitToolCall(call: ScriptedToolCall, status: "running" | "done"): void;
  emitToolResult(call: ScriptedToolCall, resultKo: string): void;
  emitAssistantDelta(text: string, isFinal: boolean): void;
  /** Called when abort() triggers — sink should clear scripted entries from view. */
  onAborted(): void;
}
```

**Idempotency**: `abort()` 2회 호출은 no-op. `start()` 동안 abort 가 들어오면 즉시 sink.onAborted() emit 후 promise resolve.

---

## 4. REC indicator

Chat header 에 다음을 표시:

- `⏺ REC` 빨강 dot + 깜빡임 (CSS animation, mockup O-X1 의 `blink 1.5s infinite`)
- "데모 시연 중 · 키 잡기" 버튼 — violet (`var(--violet)` 또는 `hsl(262 83% 58%)`)
- 항상 visible — autoplay 가 *backgrounded* 되어도 user 가 인지 가능해야 함

**구현**: `DemoAutoplayBanner.tsx` 가 ChatView 의 header slot 에 mount. ChatView state 가 `demoAutoplayActive === true` 일 때만 렌더.

---

## 5. Take-over handoff

사용자가 다음 중 하나를 하면 **즉시** scripted-turn 중단:

1. "키 잡기 →" 버튼 클릭 (DemoAutoplayBanner)
2. Composer 에 어떤 키든 입력 시작 (`composer.onFirstKeyDown`)
3. ChatView 안에서 어떤 토글/버튼이라도 누름 (defensive — UX 가 fragile 해질까봐 minimal scope)

handoff sequence:

```
user-input detected
   ↓
ScriptedTurnEngine.abort("user-takeover" | "user-input")
   ↓
ScriptedSink.onAborted() — clear scripted history entries from view
   ↓
features.demoAutoplayEnabled = false (one-shot consumed)
   ↓
features.onboardingCompleted = true (combined with API key / login flow)
   ↓
ChatView mode = "normal"
```

**Memory pollution 방지**: scripted-turn 의 user message / tool calls / assistant response 는 ChatView 의 view-only entries (kind: `"demo-autoplay-*"`) 로 표시. 실제 conversation history (`ConversationLoop.history`) 에는 *어떤 entry 도 commit 하지 않음*. 따라서 abort 시 view 만 비우면 conversation memory 는 깨끗.

---

## 6. 보안 영향 + Risk matrix

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | 사용자가 fake 결과를 real 로 오인 | HIGH | REC indicator + "데모" 라벨 + "자동 승인 (데모)" 명시. fake sandbox 의 결과는 항상 "데모: " prefix 표시 (UI 레벨). |
| R2 | demo-autoplay 가 production 에서 활성화 | HIGH | feature flag `features.demoAutoplayEnabled` default `false`. 추가 gate: `LVIS_DEMO_VENDOR` env 가 set + first-run 인 경우만 activate. packaged build 에서 env 없으면 dead code. |
| R3 | scripted turn 의 한국어 텍스트 outdated → 시연 실패 | MEDIUM | `docs/onboarding/autoplay-scripts.json` SoT + 분기별 review checklist (architecture.md §X.Y 추가 예정). |
| R4 | 후속 LLM 호출이 fake context 를 신뢰 | HIGH | scripted-turn 의 모든 entry 는 ChatView view-only (kind: `"demo-autoplay-*"`). `ConversationLoop.history` 에 commit 되지 않음 → LLM context 에 절대 들어가지 않음. 코드 invariant 로 enforce. |
| R5 | fake sandbox 가 실제 IPC handler 와 이름 충돌 → tool 호출 우회 | LOW | FakeSandbox 는 main process 의 tool dispatcher 와 분리된 module. `tool-registry.ts` 에 등록되지 않음. 우회 경로 없음. |
| R6 | audit log 에 demo entry 가 prod 분석 노이즈 | MEDIUM | 모든 demo entry 의 `input`/`output` 에 `[demo-autoplay]` prefix. 분석 query 가 prefix 로 필터 가능. type=`info` 로 통일 (turn/tool_call 과 구분). |
| R7 | abort 후 scripted state 잔존 → next session 에 누수 | MEDIUM | `features.demoAutoplayEnabled = false` 즉시 persist + memory cleanup invariant 테스트. |

---

## 7. Feature flag enforcement

`AppSettings.features.demoAutoplayEnabled?: boolean` (default `undefined` → `false`).

활성화 조건 (AND):

1. `settings.features.demoAutoplayEnabled === true` *또는* `settings.features.onboardingCompleted !== true` (first-run)
2. `process.env.LVIS_DEMO_VENDOR` 가 set
3. user 가 명시적으로 disabled 하지 않음 (`features.demoAutoplayEnabled === false` 이면 우선)

→ "first-run + LVIS_DEMO_VENDOR" 시 자동 시작; "explicit opt-in" 시도도 enable.

**packaged production**: `LVIS_DEMO_VENDOR` 가 unset 이면 dead path. shipped binary 에서 autoplay 가 silent 하게 활성화되는 사고 방지.

---

## 8. Audit prefix

모든 scripted-turn entry 는 `auditLogger.log({...})` 호출 시 `input` / `output` / `route` 필드에 **`[demo-autoplay]`** prefix.

```ts
auditLogger.log({
  type: "info",
  input: `[demo-autoplay] start scriptId=${turn.id}`,
  output: `[demo-autoplay] ok`,
  route: "demo-autoplay",
  ...
});
```

분석 query 예:

```bash
# demo 노이즈 제외
jq 'select(.route != "demo-autoplay")' ~/.lvis/audit/*.jsonl

# demo 만 추출
grep -F '"[demo-autoplay]"' ~/.lvis/audit/*.jsonl
```

---

## 9. IPC

채널 prefix: `lvis:demo-autoplay:*`. 모든 error code 는 **kebab-case English** (CLAUDE.md `IPC Error Message Language Convention`).

| Channel | Direction | Purpose | Error codes |
|---------|-----------|---------|-------------|
| `lvis:demo-autoplay:start` | renderer → main | activate scripted-turn engine | `not-enabled`, `script-not-found`, `already-running` |
| `lvis:demo-autoplay:abort` | renderer → main | abort + cleanup | `not-running` |
| `lvis:demo-autoplay:status` | renderer → main | get current state | — |

> **Note**: 본 PR 의 minimal viable 구현에서는 *renderer 내부* ScriptedTurnEngine 만 구현하고 IPC 는 wire 하지 않는다 — main process 에 demo state 가 필요하지 않기 때문 (fake sandbox 도 renderer 에서 closed loop). 위 IPC 는 PR-E3 의 enforcement 단계에서 main 보조 audit 용으로 도입. 본 PR 의 audit 은 renderer 가 기존 `auditLogger` IPC 채널 (`lvis:audit:*`) 로 entry 를 push 하는 방식.

---

## 10. Follow-up PR 분리 계획

| PR | Scope | Status |
|----|-------|--------|
| **PR-E (본 PR)** | proposal + minimal viable: ScriptedTurnEngine + FakeSandbox + DemoAutoplayBanner + meeting-summary-demo script + feature flag wiring + audit prefix | this PR |
| PR-E1 | additional scripts (calendar, work-proactive scenarios) + script SOT discipline + lint rule | follow-up |
| PR-E2 | telemetry — autoplay completion rate / abort point histogram | follow-up |
| PR-E3 | optional main-process IPC for cross-window demo state (multi-window edge case) | follow-up |

---

## 11. Test surface (본 PR)

- `src/engine/demo-autoplay/__tests__/scripted-turn-engine.test.ts` — vitest: start → tool call sequence → abort idempotency → memory invariant
- `src/engine/demo-autoplay/__tests__/fake-sandbox.test.ts` — vitest: resolve known tool → unknown tool throws → no external surface touched
- `test/e2e/ui/demo-autoplay.spec.ts` — playwright: first-run + LVIS_DEMO_VENDOR → autoplay starts → user types → REC banner disappears → demo entries cleared from view → normal chat resumes

---

## 12. Open questions (follow-up)

- **Multi-language**: 본 PR 은 한국어 script only. i18n 도입 시 script SOT 를 `meeting-summary-demo.<locale>.json` 으로 분리.
- **Pause / resume**: 본 PR 은 abort 만 지원. mockup 의 "⏸ 일시정지" 는 PR-E2 에서 추가 검토 (필요 시).
- **Multi-window**: 본 PR 은 ChatView mount 1개 가정. 추가 window 가 같은 시각에 autoplay 시도하면 두 번째 mount 는 `already-running` 으로 skip.

---

## 13. References

- Mockup SoT: `/tmp/login-lvis/index.html` (O-X1 cluster: lines ~368-431)
- Architecture: `docs/architecture/architecture.md` §4.5 (ConversationLoop), §6 (Core Engines), §8 (Approval)
- Feature flag pattern: `src/data/settings-store.ts` `FeatureFlags.onboardingCompleted` (#893)
- Audit: `src/audit/audit-logger.ts` `AuditEntry` (type: "info" channel)
- Trust boundary precedent: `src/ipc/domains/auth.ts` (#893 mockup login)
