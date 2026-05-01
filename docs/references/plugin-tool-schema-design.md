# Plugin Schema Design — LVIS

**Status:** v4 (Sprint 3-B + 4-A/B + Phase 5 반영)
**Updated:** 2026-04-18
**Architect 승인:** manifest signature + uiCallable + capability taxonomy + AJV 검증 플로우

---

## 1. 설계 원칙

플러그인은 `HostApi`를 통해 자기 자신을 등록한다. 호스트 앱은 플러그인별 코드를 포함하지 않는다.

**핵심 원칙:**

1. **Capability gate = HostApi + 선언적 capability** — HostApi 자체가 1차 게이트이며, `capabilities[]`/`uiCallable[]` 는 MS Graph · 이벤트 namespace · renderer IPC allowlist 등 HostApi 단독으로 표현 불가능한 2차 게이트를 보강한다.
2. **implement-first, declare-incrementally** — 메서드를 먼저 구현하고, LLM 파라미터 추론이 불충분할 때 `toolSchemas`를 추가한다. 빈 스키마 선언은 의미 없다.
3. **In-process + try/catch** — worker_threads 격리 없이 95% 장애를 커버. 런타임 복잡도를 낮게 유지.
4. **플러그인 저자가 스키마 수기 작성** — zod 자동추출 금지. 번들 크기·버전 충돌 없음.
5. **JSON Schema draft-07 + `type: "object"` 필수** — OpenAI/Claude/Gemini 모두 top-level object 요구.
6. **매니페스트는 호스트가 AJV+cross-field로 검증하고 실패 시 로드 거부**한다. 반면 **tool payload(런타임 인수) 검증은 플러그인 재량** — 호스트는 스키마를 LLM에 전달할 뿐, ajv/zod로 payload 를 재검증하지 않는다. 이 둘을 구분할 것: manifest 는 호스트 보안 경계, payload 는 플러그인 도메인.

---

## 2. PluginManifest 필드별 스펙

```typescript
interface PluginManifest {
  /**
   * 플러그인 고유 식별자. flat form 을 권장한다 —
   * 영문 소문자/숫자/`-`/`_`/`.` 허용 (`^[a-zA-Z][a-zA-Z0-9._-]*$`, 3~128자).
   * 실제 번들 플러그인(meeting / pageindex / ms-graph) 은 모두 flat id
   * 를 사용한다. dot-form (`com.lge.meeting-recorder`) 도 허용하지만 강제하지
   * 않는다.
   */
  id: string;
  name: string;
  version: string;
  /** 플러그인 진입점 JS 파일 경로 (플러그인 루트 기준) */
  entry: string;
  /** 플러그인 한 줄 설명 (최대 280자). 비활성 플러그인 카탈로그 · UI에 노출. */
  description?: string;
  /**
   * LLM에 노출되는 tool name 목록. underscore 형식만 허용.
   * `^[a-zA-Z_][a-zA-Z0-9_]*$` — 도트·하이픈 금지.
   * runtime.ts가 이 배열 그대로 Tool Registry에 등록.
   */
  tools: string[];
  /**
   * 메서드별 JSON Schema. runtime 은 LLM system prompt 에 삽입.
   * `description` 필수 (minLength 10), `inputSchema.type === "object"` 필수.
   * `$schema` 필드는 선택 — draft-07 URI 권장.
   */
  toolSchemas?: Record<string, {
    description: string;                       // REQUIRED, minLength 10
    inputSchema: {
      $schema?: string;                        // OPTIONAL ("http://json-schema.org/draft-07/schema#")
      type: "object";                          // REQUIRED, const "object"
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  }>;
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  /** 폐쇄형 enum — §2.3 Capabilities Taxonomy 참조. */
  capabilities?: string[];
  startupTools?: string[];
  eventSubscriptions?: string[];
  /**
   * Renderer → plugin IPC (`lvis:plugins:call`) 허용 메서드 allowlist.
   * `tools[]` 의 부분집합이어야 한다. 도구 이름 접미사에 대한 제한은 없다 —
   * 파괴적 동작의 사용자 확인 UX 는 플러그인이 자체 UI 로 구현하며, 보안은
   * 코드 리뷰·마켓플레이스 심사·서명 검증으로 보장한다. §2.2 참조.
   */
  uiCallable?: string[];
  /**
   * OS 네이티브 알림 자동 노출. `registerPluginNotifications()` 가 manifest 만
   * 읽어 onEvent 핸들러를 자동 배선한다.
   */
  notificationEvents?: Array<{
    event: string;
    titleField?: string;
    bodyField?: string;
  }>;
  installPolicy?: "admin" | "user";
  dependencies?: Array<string | { pluginId: string; versionRange?: string; required?: boolean }>;
  pluginAccess?: {
    plugins: Array<{ pluginId: string; tools?: string[]; events?: string[] }>;
  };
  publisher?: string;
  /**
   * plugin start() 하드 타임아웃 (ms). `Promise.race` 기반, 초과 시 호스트가
   * 해당 플러그인을 fail-soft drop. 실제 start() 작업 자체는 AbortController
   * 미사용이므로 cancellation 되지 않는다.
   */
  startupTimeoutMs?: number;
}
```

> `python` 필드는 **더 이상 지원되지 않는다** — AJV 스키마는 `additionalProperties: false` 이므로 매니페스트에 포함하면 로드 거부. Python 런타임은 `lvis-app/src/main/python-runtime.ts` 호스트 쪽 bootstrap 로 제공되고 플러그인은 선언 없이 사용한다.

**각 필드의 런타임 소비처:**

| 필드 | 소비처 | 타이밍 |
|------|--------|--------|
| `id` | PluginRegistry, HostApi cleanup | boot + 런타임 전반 |
| `entry` | runtime.ts `require()` | boot |
| `tools[]` | Tool Registry 등록 | boot |
| `toolSchemas` | LLM system prompt 에 tool schema 로 삽입 | system prompt 빌드 시 |
| `description` | 비활성 플러그인 카탈로그 (`listPluginCards`) | system prompt · UI |
| `keywords[]` | KeywordEngine 등록 | boot |
| `ui[]` | plugin-ui-host.tsx 마운트 | boot + UI 렌더 |
| `startupTools[]` | boot 시 자동 호출 (init 류) | boot |
| `eventSubscriptions[]` | ProactiveEngine · 이벤트 라우팅 | boot |
| `notificationEvents[]` | `registerPluginNotifications()` — OS 알림 자동 등록 | boot |
| `uiCallable[]` | `PluginRuntime.callFromUi()` allowlist | renderer IPC 호출 |
| `capabilities[]` | HostApi MS Graph 게이트 + `emitEvent` namespace 게이트 | 런타임 전반 |
| `installPolicy` | Install-policy guard + signature gate policy | install + uninstall + load |
| `dependencies` | Marketplace dependency resolver | install |
| `pluginAccess` | Cross-plugin tool/event access gate | runtime |
| `publisher` | 감사 로그 · 마켓플레이스 카드 | install + 표시 |

**plugin.json 전체 예시 (meeting 플러그인):**

```json
{
  "id": "lvis-plugin-meeting",
  "name": "회의록 녹음",
  "version": "1.3.0",
  "description": "마이크 입력을 실시간으로 전사하고 요약해 회의록을 자동 생성합니다.",
  "entry": "dist/index.js",
  "tools": [
    "meeting_start",
    "meeting_push_chunk",
    "meeting_stop",
    "meeting_transcript",
    "meeting_sessions"
  ],
  "uiCallable": ["meeting_transcript", "meeting_sessions"],
  "capabilities": ["meeting-recorder"],
  "toolSchemas": {
    "meeting_start": {
      "description": "회의 녹음 세션을 시작한다. 이후 meeting_push_chunk 로 오디오를 push 하고 meeting_stop 으로 종료한다.",
      "inputSchema": {
        "type": "object",
        "required": ["sessionId"],
        "properties": {
          "sessionId": { "type": "string", "description": "세션 고유 식별자" },
          "context": {
            "type": "object",
            "properties": {
              "title": { "type": "string" },
              "participants": { "type": "array", "items": { "type": "string" } }
            }
          }
        }
      }
    }
  },
  "keywords": [
    { "keyword": "회의록", "skillId": "meeting" },
    { "keyword": "녹음", "skillId": "meeting" }
  ],
  "installPolicy": "admin",
  "publisher": "LG Electronics DX Platform Team"
}
```

---

### 2.1 마켓플레이스 artifact 검증

플러그인 repo는 `plugin.json` sidecar signature를 만들지 않는다. Marketplace upload API가 manifest/schema/policy/access를 검증하고 최종 artifact envelope를 서명한다. Host는 설치 시 envelope를 검증하고 install receipt를 저장하며, runtime load 전에 receipt의 file hash를 확인한다.

| 상황 | 정책 |
|------|------|
| envelope 검증 성공 + receipt hash 일치 | 로드 후보. `plugin_integrity_verified` 감사 이벤트 기록. |
| envelope 검증 실패 | 설치 거부. |
| receipt 누락/불일치 | **드롭 (fail-closed)**. `plugin_integrity_rejected` 감사 이벤트 기록. |

마켓플레이스 trust anchor는 host-owned `src/plugins/marketplace-keys.ts`에 있다. `@lvis/plugin-sdk`는 type/source-only 계약이며 키를 포함하지 않는다.

### 2.2 uiCallable 보안 경계

Renderer UI 는 `lvis:plugins:call` IPC 를 통해 플러그인 메서드를 직접 호출할 수 있다. 이 경로는 ConversationLoop 의 permission/scope/expansion cap 을 **우회**하므로 매니페스트 allowlist 로 좁혀야 한다. (AI 가 개시한 도구 호출은 별개로 `ApprovalGate` / `PermissionManager` 확인 UX 를 그대로 거친다.)

**규칙:**

1. **`uiCallable ⊂ tools[]`** — allowlist 에 들어간 이름은 반드시 `tools[]` 에 선언된 이름이어야 한다. 어긋나면 매니페스트 로드 거부. 이 구조적 제약만 런타임에서 강제된다.
2. **도구 이름 제한 없음** — 어떤 접미사든 `uiCallable` 에 넣을 수 있다. 파괴적 동작의 사용자 확인은 플러그인 UI 가 자체 구현한다 (예: 삭제 버튼 → "정말 삭제?" 다이얼로그). 보안은 코드 리뷰·마켓플레이스 심사·서명 검증으로 보장한다. 실제 위험 작업(민감 파일 경로 접근, 샌드박스 탈출 등)은 호스트의 `sensitive-paths.ts`·샌드박스 계층에서 이름이 아닌 작업의 실체로 차단한다.
3. **Renderer IPC 게이트** — `PluginRuntime.callFromUi(method, payload)` 는 매번 `manifest.uiCallable` 을 재확인한다. allowlist 바깥 호출은 throw.

**예시:**

```jsonc
// OK — read-only 메서드
"uiCallable": ["meeting_transcript", "meeting_sessions"]

// OK — 파괴적 동작도 등록 가능. 플러그인이 자체 UI 에서 확인 다이얼로그를 구현해야 함
"uiCallable": ["msgraph_email_reply", "msgraph_calendar_delete", "index_remove_folder"]

// REJECT — tools[] 에 없는 이름
"uiCallable": ["meeting_unknown"]
```

### 2.3 capabilities Taxonomy (Phase 5)

`capabilities[]` 는 **폐쇄형 enum** 이다 (`src/plugins/capabilities.ts` 의 `KNOWN_CAPABILITIES`). 등록되지 않은 문자열은 AJV+런타임에서 거부된다.

| 값 | 강제/자문 | 역할 |
|----|-----------|------|
| `ms-graph-consumer` | advisory (PR 3 이후) | Microsoft Graph 를 사용하는 플러그인의 자기-식별 라벨. PR 3 에서 host 측 MS HostApi 메서드가 모두 제거되어 강제할 게이트가 없으므로 advisory 로 강등. ms-graph 플러그인이 자체 MSAL + safeStorage 로 직접 인증 처리 (architecture.md §9.4a "Plugin-Owned OAuth Authentication" 참조). |
| `external-auth-consumer` | **enforced** | `openAuthWindow` 호출 필수. 실 Chromium 창을 띄워 외부 포털 세션 쿠키를 수집하는 민감 operation — 선언적 opt-in 없이는 거부. |
| `mail-source` | **enforced** | `email.*` 이벤트 emit 게이트. 미선언 시 emit 이 드롭되고 warn. |
| `calendar-source` | **enforced** | `calendar.*` emit 게이트. |
| `meeting-recorder` | **enforced** | `meeting.*` emit 게이트. |
| `knowledge-index` | **enforced** | `index.*` emit 게이트. |
| `background-watcher` | advisory | `startupTools` 기반 폴러/감시자 사용 선언. 런타임 게이트 없음 (향후 enforce 예정). |
| `worker-client` | advisory | 외부 프로세스(Python uv 등) 워커 래퍼 선언. |
| `conversation-trigger` | **enforced** | `triggerConversation()` 호출 필수. 사용자가 입력하지 않은 prompt 로 ConversationLoop 를 발사하는 차별화 surface — 일반 plugin 에 부여하지 말 것. proactive 두뇌 plugin 전용. 자세한 설계는 [`conversation-trigger.md`](./conversation-trigger.md) 참조. |

**이벤트 subscription 정책** (`classifySubscription`):

- `memory.private.*`, `settings.apiKey.*`, `audit.*`, `dlp.*` → `PLUGIN_PRIVATE_NAMESPACES` 에 매칭되어 **subscription 거부** (wiring 시 throw).
- `meeting`, `calendar`, `email`, `index`, `task`, `briefing` → public. 조용히 허용. `task.*` namespace 는 host 의 `TaskDeadlinePoller` (`src/main/task-deadline-poller.ts`) 가 owner — 현재 `task.deadline.approaching` 발행 (msUntilDeadline 포함). 추가 task lifecycle 이벤트 는 향후 확장.
- 그 외 → neutral. 허용하되 namespace drift 추적 warn.

### 2.4 AJV 매니페스트 검증 플로우

```
plugin.json
   │
   ▼
┌──────────────────────────────────┐
│ 1. JSON.parse                    │  → 실패 시
│                                  │     [manifest:<unknown>] JSON parse error
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ 2. AJV schema validation         │  schemas/plugin.schema.json
│    (strict, allErrors, formats)  │  → 실패 시
│                                  │     [manifest:<pid>] schema validation failed: <errs>
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ 3. Cross-field checks            │  runtime.ts readManifest()
│    - tool name regex             │
│    - startupTools ⊂ tools        │
│    - uiCallable ⊂ tools          │
│    - startupTimeoutMs > 0        │
│    - notificationEvents shape    │  → 실패 시
│                                  │     Invalid plugin manifest '<id>' at '<field>' (<path>): <reason>. Example: <example>
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ 4. Signature verifier            │  ed25519 over manifest bytes
│    (§2.1)                        │  → 실패 시 (managed) 드롭 + audit
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ 5. Capability enforcement        │  KNOWN_CAPABILITIES + emit namespace
│                                  │  → event drop on missing capability
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ 6. Entry import                  │  import(pathToFileURL(entry))
└──────────────────────────────────┘
```

**단계별 실제 에러 포맷:**

```
[manifest:<unknown>] JSON parse error (Unexpected token ...). Example: {"id":"com.lge.sample",...}
[manifest:lvis-plugin-meeting] schema validation failed (/path/to/plugin.json): /uiCallable/0 must match pattern "^[a-zA-Z_][a-zA-Z0-9_]*$"
Invalid plugin manifest 'lvis-plugin-meeting' at 'startupTools[0]' (/path/to/plugin.json): entry 'meeting_watch' is not declared in tools[]. Example: add "meeting_watch" to tools[] or remove it from startupTools[]
Invalid tool name 'meeting.start' in plugin 'lvis-plugin-meeting' at 'tools[0]' (/path/to/plugin.json): tool names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). Example: "tools": ["meeting_start"] (not "meeting.start")
[plugin-runtime] managed plugin 'lvis-plugin-ms-graph' rejected — signature invalid
[plugin-runtime] managed plugin 'lvis-plugin-meeting' rejected — signature file missing
```

각 단계는 fail-soft drop (해당 플러그인만 제외하고 나머지는 계속 로드).

---

## 3. toolSchemas 작성 가이드

`toolSchemas` 는 LLM 이 파라미터를 잘못 추론하는 메서드에만 추가한다.
top-level 은 반드시 `"type": "object"` — 모든 LLM vendor 공통 요구사항.
`description` 은 **필수** (`minLength: 10`) — 10자 미만이면 AJV 가 거부한다.

### 예시 1: meeting_push_chunk (바이너리 데이터 포함)

```json
{
  "meeting_push_chunk": {
    "description": "PCM16LE 오디오 청크를 세션에 추가. STT는 비동기 처리.",
    "inputSchema": {
      "type": "object",
      "required": ["sessionId", "chunk"],
      "properties": {
        "sessionId": { "type": "string" },
        "chunk": {
          "type": "object",
          "required": ["pcm16leMono", "sampleRate"],
          "properties": {
            "pcm16leMono": {
              "type": "array",
              "items": { "type": "integer" },
              "description": "16-bit signed PCM 샘플 배열 (IPC 전달 시 number[])"
            },
            "sampleRate": { "type": "integer", "enum": [16000, 44100, 48000] },
            "startSec": { "type": "number" },
            "endSec": { "type": "number" }
          }
        }
      }
    }
  }
}
```

> **교훈**: `pcm16leMono`는 TypeScript에서 `number[]`로 전달된다. JSON Schema `items.type: "integer"`로 LLM에 명시하지 않으면 LLM이 base64 string을 시도할 수 있다.

### 예시 2: msgraph_calendar_create (nested required + attendees 배열)

```json
{
  "msgraph_calendar_create": {
    "description": "Microsoft Graph를 통해 캘린더 일정 생성. 참석자 이메일 배열을 지원한다.",
    "inputSchema": {
      "type": "object",
      "required": ["title", "start", "end"],
      "properties": {
        "title": { "type": "string", "maxLength": 255 },
        "start": { "type": "string", "format": "date-time", "description": "ISO 8601" },
        "end":   { "type": "string", "format": "date-time" },
        "body": { "type": "string" },
        "location": { "type": "string" },
        "timeZone": { "type": "string", "description": "IANA 시간대. 예: Asia/Seoul" },
        "attendees": {
          "type": "array",
          "items": { "type": "string", "format": "email" },
          "description": "참석자 이메일 목록"
        }
      }
    }
  }
}
```

### 예시 3: msgraph_email_reply (사전 조건 명시)

```json
{
  "msgraph_email_reply": {
    "description": "지정 이메일에 답장. msgraph_email_list 또는 msgraph_email_read로 id를 먼저 획득해야 함.",
    "inputSchema": {
      "type": "object",
      "required": ["id", "body"],
      "properties": {
        "id": { "type": "string", "description": "msgraph_email_list 응답의 id 필드" },
        "body": { "type": "string", "description": "답장 본문 (plain text 또는 HTML)" },
        "subject": { "type": "string", "description": "선택. 생략 시 원본 제목 유지" },
        "to": { "type": "string", "description": "선택. 생략 시 원본 발신자에게 답장" }
      }
    }
  }
}
```

**작성 체크리스트:**

- [ ] top-level `"type": "object"` 선언
- [ ] `description` 10자 이상 (AJV `minLength: 10`)
- [ ] `required` 배열에 필수 파라미터 명시
- [ ] `description`으로 LLM에 사전 조건 전달 (예: "먼저 X를 호출해야 함")
- [ ] enum 값이 있으면 `enum` 키 사용 (LLM 환각 방지)
- [ ] 선택 필드는 `required`에서 제외 (null 강요 금지)

---

## 4. HostApi 메서드

플러그인이 호스트에 접근하는 유일한 경로. `PluginHostApi` 인터페이스 (`src/plugins/types.ts`).

| 메서드 | 언제 쓰나 | 언제 쓰지 말아야 하나 |
|--------|-----------|----------------------|
| `registerKeywords(keywords)` | boot 시 KeywordEngine에 트리거 등록 | 런타임 중 동적 추가 (boot 전용) |
| `emitEvent(name, payload)` | 다른 플러그인·ProactiveEngine에 이벤트 발행 (capability gate) | 직접 플러그인 간 함수 호출 대체 |
| `onEvent(name, handler)` | 다른 플러그인 이벤트 구독 (private namespace 차단) | 폴링 대체 (push 모델로 충분) |
| `addTask(task)` | 액션 아이템 → LVIS 태스크 자동 생성 (host `taskService` → `~/.lvis/tasks/lvis-tasks.db` SQLite). | UI 직접 조작 대체 |
| `saveNote(title, content)` | `~/.lvis/notes/`에 회의록·요약 저장 | 대용량 바이너리 저장 |
| `getSecret(key)` | 암호화된 API 키 조회 | 키를 메모리에 캐시 후 재사용 (매번 호출) |
<!-- PR 3c: getMsGraphToken / startMsGraphAuth / isMsGraphAuthenticated / getMsGraphAccount / onMsGraphAuthChange / withMsGraphRetry — host HostApi 에서 제거됨. ms-graph 플러그인이 자체 MSAL 소유. architecture.md §9.4a "Plugin-Owned OAuth Authentication" 참조. -->
| `callLlm(prompt, options?)` | 호스트 LLM 으로 단발 텍스트 생성 (선제성 본문·분류·요약) | 대화 히스토리·streaming·tool_use 필요 시 (플러그인이 직접 SDK 사용) |
| `openAuthWindow(options)` ([external-auth-consumer] 필요) | 외부 포털 interactive 로그인 창을 띄우고 지정 도메인 쿠키 수집 (Selenium/webdriver 대체) | OAuth-style localhost callback이 되는 표준 플로우 (→ MS Graph 패턴 사용) |
| `triggerConversation(spec)` ([conversation-trigger] 필요) | 관찰된 신호를 바탕으로 ConversationLoop 를 능동적으로 발사 ("먼저 말 거는 비서" 차별화) | 사용자 input → tool 결과 패턴 (chat 으로 충분) — 자세한 사용 패턴 / 안전 계약은 [`conversation-trigger.md`](./conversation-trigger.md) |
| `getInstalledPluginIds()` | 다른 플러그인 설치 여부 체크 — 의존성-인식 detector / 조건부 UI (예: work-proactive 가 ms-graph 설치 시에만 메일 detector 등록) | 우선순위 추론 (insertion order ≠ priority). 향후 capability-filtered 변종 (`getProvidersFor(capability)`) 가 superseding 예정 — Phase 1 은 unscoped |
| `onPluginsChanged(handler)` | install/uninstall 발생 시 reactive 재구성 (예: detector list rebuild). handler 는 `PluginLifecycleEvent` 받음 (`{type, pluginId, source}` discriminated union, self-event 자동 필터). production consumer 는 `source: "local-dev"` 무시 권장 | `updated` (버전 bump) — 별도 spec 진행 중 (P0 미지원). handler 는 forward-compat 위해 `default:` 분기 필수 |
| `logEvent(level, message, data?)` | 호스트 감사 로그에 플러그인 이벤트 기록 | 디버그 전용 고빈도 로깅 (성능) |
| `onShutdown(handler)` | 앱 종료 전 정리 작업 (DB flush, 파일 저장 등) | 긴 비동기 작업 (5s 제한) |

### callLlm 상세 (Sprint 4-B §B-7)

```typescript
// 플러그인이 선제성 제안 본문을 생성하는 예
const suggestion = await hostApi.callLlm(
  `다음 이메일이 미팅 제안인지 판단하고, 제안이면 제목·일시를 한국어로 요약: ${emailBody}`,
  { maxTokens: 300, systemPrompt: "당신은 캘린더 보조 비서입니다." }
);
```

- 호스트 `ConversationLoop.generateText()`에 위임 — 사용자가 설정한 현재 벤더·모델이 그대로 사용된다.
- **대화 히스토리와 무관한 단발 호출** — 매번 독립. multi-turn 대화가 필요하면 플러그인이 직접 SDK 사용.
- `provider.streamTurn()` 에서 `error` 이벤트가 오면 throw — 부분 응답을 성공으로 삼지 않는다.
- LLM 미설정 상태 호출 시 `"LLM provider not configured"` throw.
- **Rate-limit / token clamp / 감사 (강제, `src/boot/conversation.ts` → `createCallLlmForPlugin`):**
  - **Per-plugin sliding window**: `20 calls / 10 분`. 초과 시 `[plugin:<id>] callLlm rate-limit exceeded — 20 calls per 600000ms` throw + `error` 감사 이벤트.
  - **maxTokens clamp**: 요청 값이 양의 정수가 아니면 무시, 그 외에는 `Math.min(raw, 4096)` 로 clamp.
  - **전건 감사 로그**: 호출 성공·실패 모두 `sessionId: "plugin"`, `type: "tool_call"` 로 기록 (`[plugin:<id>] callLlm promptLen=<n> maxTokens=<n>`).
- Surface 는 의도적으로 좁게 유지: streaming·tool_choice·thinking 등 vendor 편차 큰 기능은 제외. §6.3 참조.

### openAuthWindow 상세

```typescript
// 플러그인이 LGE 포털 쿠키를 수집하는 예
const cookies = await hostApi.openAuthWindow({
  url: "http://space.lge.com/",
  completionUrlPatterns: ["newep.lge.com/portal/main", "space.lge.com"],
  cookieHosts: ["sso.lge.com", "newep.lge.com", "space.lge.com"],
  timeoutMs: 300_000,
  windowTitle: "LGE 포털 로그인",
});

// 반환된 쿠키로 직접 HTTP 요청
const jar = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const res = await fetch("https://newep.lge.com/api/...", { headers: { Cookie: jar } });
```

- Electron 내장 Chromium `BrowserWindow` + `session.cookies` API 사용 — **Selenium/webdriver 의존 제거**.
- 사용자가 창 안에서 SSO 로그인 수행 → `completionUrlPatterns` 중 하나와 매칭되는 URL로 navigate되면 쿠키 수집 후 창 자동 close.
- `cookieHosts`는 **도메인 suffix 매칭** (선행 점 정규화) — `evil-lge.com`이 `lge.com`에 매칭되지 않도록 엄격 비교.
- 타임아웃(기본 5분), 사용자 창 수동 close, `loadURL` 실패 모두 reject.
- `persistPartition`(예: `persist:lge-auth`)을 지정하면 영구 세션 격리 — 여러 포털 간 쿠키 교차 방지.
- **Capability gate**: `manifest.capabilities[]` 에 `external-auth-consumer` 선언 필수. 미선언 시 호출은 `throw` 되고 AuditLogger 에 `open_auth_window_capability_denied` 레코드가 남는다.
- 허용된 호출도 AuditLogger 에 기록되어 어떤 플러그인이 어떤 포털에 대해 쿠키를 수집했는지 추적 가능.
- 로그/감사에는 **URL 의 origin + path 만** 기록 — SAML/OAuth 응답 URL 에 담기는 `SAMLRequest` / `code` / `state` / 세션 토큰은 민감 자산이므로 query/hash 를 제외한다.
- **§6.1 "3+ 플러그인 규칙" 예외 #2 (보안·감사 통제 필요)**로 정당화. 외부 포털 쿠키 수집은 민감 자산 취급이므로 단일 플러그인 사용처여도 HostApi에서 제공한다.

### logEvent 상세

```typescript
hostApi.logEvent("info", "meeting.ended", { sessionId, duration: 3600 });
hostApi.logEvent("warn", "stt.retry", { attempt: 2, error: "rate_limit" });
hostApi.logEvent("error", "summary.failed", { sessionId, error: e.message });
```

- 호스트 `audit-logger.ts`로 라우팅. DLP 필터 통과.
- `data` 필드는 직렬화 가능한 값만 허용 (Buffer, class instance 금지).
- `console.log` 대신 사용하면 중앙 감사 로그에 남는다.

### onShutdown 상세

```typescript
hostApi.onShutdown(async () => {
  await sessionStore.flushAll();
  watcher.stop();
});
```

- Electron `before-quit` 이벤트 체인에서 호출.
- `Promise.allSettled` 로 모든 플러그인 shutdown 병렬 실행.
- 5초 초과 시 강제 종료 (로그 기록 후).
- 등록 순서와 실행 순서는 무관.

---

## 4.5 IPC/RPC 범위 (Scope)

LVIS 는 IPC/RPC 를 **시스템 레벨 전용**으로 확정한다. 플러그인은 IPC/RPC 개념을 알 필요가 없다.

### 시스템 레벨 IPC (호스트가 사용)

| 영역 | 채널/프로토콜 | 용도 |
|------|---------------|------|
| Host ↔ Renderer | Electron `ipcMain.handle()` (`lvis:settings:*`, `lvis:chat:*`, `lvis:memory:*`, `lvis:permissions:*`, `lvis:plugins:call`) | UI ↔ 메인 프로세스 |
| Marketplace | HTTPS REST (`/plugins/list`, `/plugins/download`) | 플러그인 카탈로그 + 다운로드 |
| Governance Server | HTTPS REST | 정책·감사 업로드 |
| MCP | stdio/HTTP (MCP 프로토콜) | 외부 MCP 서버와 통신 |

호스트는 이 계층에서만 IPC 채널 이름과 RPC 스키마를 정의한다. `RESERVED_HOST_CHANNELS` Set 이 플러그인의 채널 이름 충돌을 차단한다.

### 플러그인의 통신 경계

플러그인은 **tool 레벨만** 사용한다:

- **LLM → plugin tool**: `ToolRegistry` 경유. manifest `tools[]` 에 선언된 이름이 LLM 에 노출, 호출 시 `handlers[toolName]` 로 라우팅. IPC 채널 없음.
- **Renderer UI → plugin tool**: 호스트가 제공하는 generic 핸들러 `lvis:plugins:call(toolName, payload)` 단 하나 경유. `manifest.uiCallable` allowlist 로 구조적 gating (§2.2) — 이름 패턴 차단은 없으며, 확인 UX 는 플러그인이 자체 UI 로 구현한다. 플러그인이 채널을 직접 선언하지 않는다.
- **Plugin → host service**: `PluginHostApi` 메서드 직접 호출 (in-process).
- **Plugin → plugin**: 이벤트 버스(`hostApi.emitEvent` / `onEvent`) 만. 직접 호출 불가. emit 은 capability 로, subscribe 는 namespace 분류로 gating.

매니페스트에 IPC 바인딩 필드는 존재하지 않으며, 플러그인 번들에서도 Electron `ipcRenderer`/`ipcMain` 을 직접 사용하면 안 된다.

---

## 5. 번들 플러그인 케이스스터디

### 5.1 Meeting Recorder (`lvis-plugin-meeting`)

**파일:** `lvis-plugin-meeting/src/hostPlugin.ts:128-200`

**주요 handler:** `meeting_start` / `meeting_push_chunk` / `meeting_stop` / `meeting_transcript` / `meeting_sessions`.

- `capabilities: ["meeting-recorder"]` — `meeting.*` emit 게이트 통과.
- `uiCallable: ["meeting_transcript", "meeting_sessions"]` — 렌더러에서 직접 호출해도 안전한 조회용 메서드를 노출. (파괴적 도구를 추가할 수도 있으며, 그 경우 플러그인 UI 가 확인 다이얼로그를 책임진다.)
- `toolSchemas` 는 `meeting_push_chunk` 에 추가 (PCM `number[]` 추론 실패 방지).
- `meeting_stop` 반환값이 크므로 LLM context 소비 주의 — 요약만 반환.

### 5.2 PageIndex (`lvis-plugin-pageindex`)

**파일:** `lvis-plugin-pageindex/src/hostPlugin.ts:210-303`

- `capabilities: ["knowledge-index", "worker-client"]`.
- Python subprocess (30s 폴링) 로 FileWatcher 대신 운영 — `index_scan` 은 멱등 설계.
- `index_add_folder` 는 `/etc`, `/usr`, `~/.ssh` 등 위험 경로를 플러그인이 스스로 차단 — HostApi 레벨 제어 없음.
- `toolSchemas` 권고: `index_add_folder` 에 추가.

### 5.3 Email (`lvis-plugin-email`)

**파일:** `lvis-plugin-email/src/hostPlugin.ts:90-191`

- `capabilities: ["mail-source", "ms-graph-consumer", "background-watcher"]`.
- ms-graph 플러그인 내부에서 모든 인증 필요 handler 진입부의 `if (!isAuthed()) throw` 패턴 — plugin 자체 MsalClient 가 일관 게이트 (PR 3 이후).
- `email_analyze` 는 내부적으로 LLM 을 직접 호출하거나 `hostApi.callLlm` 으로 전환 가능.
- `email_start_watcher`/`email_stop_watcher` 는 `startupTools` 나 UI 에서 호출하는 것이 자연스럽다.
- `email_send` 같은 파괴적 메서드도 `uiCallable` 에 넣을 수 있다 (§2.2) — 플러그인이 전송 전 확인 다이얼로그를 자체 UI 로 구현해야 한다.

### 5.4 Calendar (`lvis-plugin-calendar`)

**파일:** `lvis-plugin-calendar/src/hostPlugin.ts:92-188`

- `capabilities: ["calendar-source", "ms-graph-consumer"]`.
- `calendar_create.attendees` 는 LLM 이 단일 문자열로 전달하는 경우가 있음 — `toolSchemas` 에 `type: "array"` 명시 필수.
- `calendar_open_url` 은 URL scheme 검증 (https 만 허용) 을 플러그인이 직접 수행.

---

## 6. HostApi 확장 가이드

### 6.1 새 메서드 추가 조건 — "3+ 플러그인 규칙"

HostApi 에 새 메서드를 추가하려면:

1. **3개 이상의 플러그인이 동일 기능을 필요로 해야** — 1~2개는 플러그인이 직접 구현.
2. 보안·감사 통제가 필요한 경우 (예: 파일 쓰기, 외부 네트워크) — 1개 플러그인도 가능.
3. host 앱이 이미 가진 서비스를 노출하는 경우 (예: MS Graph 토큰).

### 6.2 추가 절차

1. `src/plugins/types.ts` 의 `PluginHostApi` 인터페이스에 메서드 추가
2. `src/boot.ts` HostApi 팩토리에 실제 구현
3. 필요 시 `src/plugins/capabilities.ts` 에 capability + gate 추가
4. `docs/references/plugin-tool-schema-design.md` §4 표 업데이트
5. `docs/architecture/architecture.md` §9.2 / §9.4 업데이트
6. 변경 커밋 — 플러그인 저자에게 공지 (semver minor bump)

### 6.3 설계 결정 목록 (승인/기각)

| 제안 | 결정 | 사유 |
|------|------|------|
| **worker_threads / process 격리** | ❌ 기각 | in-process + try/catch 로 95% 장애 커버. 격리 시 IPC 오버헤드 + 디버깅 복잡도 증가. |
| **marketplace artifact 검증** | ✅ **승인** | 플러그인 저자가 sidecar 서명을 만들지 않고 marketplace가 artifact envelope을 서명합니다. 호스트는 설치 시 envelope을 검증하고 로드 시 install receipt 해시를 확인합니다. §2.1. |
| **`permissions[]` 선언형 필드** | ⚠️ **부분 승인** | full permission 문자열 배열은 기각되었지만, 다음 3종의 선언형 게이트가 대체 도입됨: (1) `uiCallable[]` — renderer→plugin allowlist (구조적 `⊂ tools[]` 제약만 강제, 파괴적 도구의 확인 UX 는 플러그인이 책임), (2) `capabilities[]` — `ms-graph-consumer` HostApi gate + event-emit namespace gate, (3) `PLUGIN_PRIVATE_NAMESPACES` — subscription deny-list. §2.2, §2.3. |
| **LLM invoke HostApi 추상화 (full surface)** | ❌ 기각 (callLlm 만 채택) | 단발 텍스트 생성 `callLlm()` 만 Phase 1에서 채택 (§4). streaming·tool_choice·thinking·multi-turn 등 vendor 편차 큰 surface 는 여전히 기각. |
| **파일 watcher HostApi (`watchFiles`)** | ❌ 기각 | pageindex 1개 플러그인만 필요. "3+ 플러그인 규칙" 미충족. |
| **zod 자동 schema 추출** | ❌ 기각 | 번들 크기 증가, zod 버전 충돌. 수기 작성이 LLM 최적화 면에서도 우수. |
| **`toolSchemas` output schema (Phase 1)** | ❌ 기각 | 응답은 LLM 이 string 으로 재소비 가능. Phase 2 에서 재검토. |
| **Full capability grant system** | ❌ 기각 | 현행 capability taxonomy (§2.3) + HostApi boundary 로 충분. |
| **Hot reload (Phase 1)** | ❌ 기각 | 개발 편의 기능. GA 블로커 아님. |
| **`triggerConversation` HostApi + `conversation-trigger` capability** | ✅ **승인** (Brain P0) | §6.1 예외 #2 — proactive trigger 는 사용자 입력 없이 ConversationLoop 를 발사하므로 audit / source-aware permission / capability gate / per-plugin rate limit (60s/6) / dedupe / source-pattern + length cap / prompt-length cap 같은 통제가 필수. 단일 consumer 라도 host 에 둠 (plugin-side 재구현 시 통제 일관성 X). 안전 계약 / spec / gate 는 [`conversation-trigger.md`](./conversation-trigger.md). |

---

## 7. Tool 명명 / Deployment

### 명명 규칙

- **LLM tool name**: `^[a-zA-Z_][a-zA-Z0-9_]*$` — underscore 형식. `tools[]` 에 직접 선언.
- **플러그인 ID**: `^[a-zA-Z][a-zA-Z0-9._-]*$` (3~128자). flat form 권장, dot form 허용.
- **이벤트 채널**: dot 형식 (`meeting.started`, `email.action.needed`). capability 게이팅 대상 (§2.3).
- 런타임 변환 없음 — manifest 에 선언한 이름이 그대로 Tool Registry 에 등록됨.

### Deployment 모드

| 항목 | `managed` | `user` |
|------|-----------|--------|
| 설치 주체 | 회사 IT Admin / marketplace admin review | 사용자 marketplace publish |
| 삭제 권한 | 회사만 (`PluginDeploymentGuard.canUninstall()` = false) | 사용자 자유 |
| 업데이트 | 정책 push 시 강제 | 사용자 opt-in |
| 저장 경로 | `~/.lvis/plugins/installed/<id>/` | `~/.lvis/plugins/installed/<id>/` |
| 검증 | marketplace envelope + install receipt 해시 fail-closed | marketplace envelope + install receipt 해시 fail-closed |

상세 설계: `docs/architecture/plugin-deployment-model.md`

### 현행 코드 참조

| 역할 | 파일 |
|------|------|
| `PluginManifest` 타입 | `src/plugins/types.ts` |
| `PluginHostApi` 인터페이스 | `src/plugins/types.ts` |
| 플러그인 런타임 (로딩·주입·AJV·설치 영수증 검증) | `src/plugins/runtime.ts` |
| Manifest JSON Schema | `schemas/plugin.schema.json` |
| Capability taxonomy | `src/plugins/capabilities.ts` |
| Marketplace artifact verifier | `src/plugins/envelope-verifier.ts` |
| Marketplace keys (host-owned) | `src/plugins/marketplace-keys.ts` |
| Install receipt integrity | `src/plugins/plugin-install-receipt.ts` |
| Deployment 가드 | `src/plugins/deployment-guard.ts` |
| callLlm rate-limit | `src/boot/conversation.ts` (`createCallLlmForPlugin`) |
| 등록 진입점 | `src/boot.ts` |
| 번들 플러그인 빌드 | `package.json` `prepare:plugins` |

---

## 8. 플러그인 저자 Quick-Start

### 스캐폴딩

```
my-plugin/
  plugin.json          ← manifest
  package.json
  tsconfig.json
  src/
    index.ts           ← RuntimePluginFactory export
    hostPlugin.ts      ← handler 구현
  dist/
    index.js           ← 빌드 산출물 (entry 참조)
```

### 최소 플러그인 구현

```typescript
// src/index.ts
import { createPlugin } from "./hostPlugin";
export default createPlugin;

// src/hostPlugin.ts
import type { RuntimePluginFactory } from "@lvis/plugin-sdk";

export const createPlugin: RuntimePluginFactory = async (context) => {
  const { hostApi, config, log } = context;

  hostApi.registerKeywords([{ keyword: "내키워드", skillId: "my-skill" }]);

  return {
    start: async () => { log("플러그인 시작"); },

    handlers: {
      my_action: async (payload?: unknown) => {
        const p = (payload ?? {}) as { input?: string };
        if (!p.input) throw new Error("input이 필요합니다.");
        return { result: p.input.toUpperCase() };
      },
    },
  };
};
```

### plugin.json 최소 예시

```json
{
  "id": "com.example.my-plugin",
  "name": "내 플러그인",
  "version": "1.0.0",
  "description": "입력을 대문자로 변환하는 샘플 플러그인.",
  "entry": "dist/index.js",
  "tools": ["my_action"],
  "installPolicy": "user"
}
```

### 첫 메서드까지 체크리스트

- [ ] `tools[]` 이름과 `handlers` 키가 정확히 일치
- [ ] 모든 handler 가 `payload?: unknown` 을 타입 캐스팅 후 사용
- [ ] 필수 파라미터 누락 시 `throw new Error()` 로 명확한 에러 메시지
- [ ] `dist/index.js` 가 `RuntimePluginFactory` 를 default export
- [ ] `plugin.json` 의 `entry` 가 실제 빌드 산출물 경로
- [ ] LLM 파라미터 추론 테스트 후 필요시 `toolSchemas` 추가 (`description` 10자 이상)
- [ ] marketplace publish/upload 경로로 artifact를 게시

### @lvis/plugin-sdk (현행)

번들 플러그인 (`lvis-plugin-meeting` / `lvis-plugin-pageindex` / `lvis-plugin-email` / `lvis-plugin-calendar`) 은 이미 `node_modules/@lvis/plugin-sdk` 경유로 타입/팩토리 시그니처를 공유한다. SDK 는 `src/plugins/types.ts` 의 공개 타입을 재배포한다. npm publish 파이프라인은 4개 번들 플러그인 안정화 후 확정 예정이지만, 로컬 workspace 링크는 이미 운영 중이다.

```jsonc
// tsconfig.json (플러그인)
{
  "compilerOptions": {
    "paths": {
      "@lvis/plugin-sdk": ["../../lvis-app/src/plugins/types"]
    }
  }
}
```
