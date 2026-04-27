# LVIS 플러그인 개발 가이드

> **상태**: Sprint 4-A + 4-B 반영판 (2026-04-18)
> **대상**: LVIS 플러그인 개발자
> **선행 읽음**: [아키텍처 문서 §9](../architecture/architecture.md#9-plugin-system--ui-extension) · [CLAUDE.md](../../CLAUDE.md)
>
> **로컬 dev 루프부터 시작하려면** → [`local-plugin-development.md`](./local-plugin-development.md) (사이드로드) 또는 [`local-marketplace-testing.md`](./local-marketplace-testing.md) (로컬 마켓플레이스 end-to-end). 이 문서는 깊은 레퍼런스입니다.

---

## 목차

1. [플러그인이란](#플러그인이란)
2. [플러그인 매니페스트 (plugin.json)](#플러그인-매니페스트-pluginjson)
3. [호스트 플러그인 엔트리 (hostPlugin.ts)](#호스트-플러그인-엔트리-hostplugints)
4. [HostApi 계약](#hostapi-계약)
5. [도구 명명 규칙](#도구-명명-규칙)
6. [toolSchemas 작성 가이드](#toolschemas-작성-가이드)
7. [uiCallable 보안 경계](#uicallable-보안-경계)
8. [capabilities 체계](#capabilities-체계)
9. [이벤트 구독 및 OS 알림](#이벤트-구독-및-os-알림)
10. [서명 및 배포 (ed25519)](#서명-및-배포-ed25519)
11. [레이트 리밋·예산](#레이트-리밋예산)
12. [IPC/RPC 경계](#ipcrpc-경계)
13. [UI 확장](#ui-확장)
14. [빌드 설정](#빌드-설정)
15. [테스팅](#테스팅)
16. [설치 및 배포](#설치-및-배포)
17. [완전한 예제](#완전한-예제)
18. [체크리스트](#체크리스트)
19. [미구현 · 열린 TODO](#미구현--열린-todo)

---

## 플러그인이란

LVIS 플러그인은 **자기 등록 방식의 모듈식 확장**입니다. 호스트 앱이 플러그인 특정 코드를 갖지 않고, 플러그인이 시작 시 `context.hostApi`를 통해 자신을 등록합니다.

### 핵심 원칙

1. **호스트는 플러그인을 몰라야 함** — 모든 플러그인 통합은 HostApi를 통해 이루어짐
2. **독립적 생명주기** — 플러그인 추가/제거 시 호스트를 수정하지 않음
3. **명확한 계약** — PluginManifest + HostApi 인터페이스로 정의됨
4. **Fail-soft** — 한 플러그인이 죽어도 호스트와 다른 플러그인은 계속 동작

---

## 플러그인 매니페스트 (plugin.json)

플러그인 매니페스트는 호스트가 플러그인을 발견하고 로드하기 위한 메타데이터입니다. `schemas/plugin.schema.json` 에 정의된 JSON Schema (draft-07) 로 로드 시 **AJV 검증**됩니다.

### 전체 스키마

```typescript
interface PluginManifest {
  // ── 필수 ──
  id: string;              // 플러그인 식별자 (flat 또는 도트 형식; 아래 "id 형식" 참고)
  name: string;            // 사람이 읽는 이름
  version: string;         // Semver "MAJOR.MINOR.PATCH[-prerelease][+build]"
  entry: string;           // hostPlugin.js 진입점 경로 (pluginRoot 기준)
  tools: string[];         // LLM tool name 배열 (^[a-zA-Z_][a-zA-Z0-9_]*$)

  // ── 문서/메타 ──
  description?: string;    // LLM 카탈로그·UI에 표시되는 1줄 요약 (≤280자)
  publisher?: string;      // 퍼블리셔 식별자 (예: "LG Electronics IT")
  installPolicy?: "admin" | "user"; // 설치 정책. 배포 경로는 marketplace 단일 경로.
  dependencies?: Array<string | { pluginId: string; versionRange?: string; required?: boolean }>;
  pluginAccess?: {
    plugins: Array<{ pluginId: string; tools?: string[]; events?: string[] }>;
  };

  // ── 런타임/정책 ──
  config?: Record<string, unknown>;  // 기본 설정값
  capabilities?: string[];           // 기능 태그 (§capabilities 체계)
  startupTools?: string[];           // 부팅 시 자동 실행할 tools[] 항목
  startupTimeoutMs?: number;         // start() 하드 타임아웃 (1 ≤ n ≤ 60000)

  // ── UI / LLM 통합 ──
  ui?: PluginUiExtension[];                                      // 사이드바 UI 슬롯
  keywords?: Array<{ keyword: string; skillId: string }>;         // 키워드 엔진 등록
  toolSchemas?: Record<string, {                                  // LLM function-calling 스키마
    description: string;
    inputSchema: { type: "object"; properties: ...; required?: string[]; additionalProperties?: boolean };
  }>;
  uiCallable?: string[];             // 렌더러 IPC에서 직접 호출 허용되는 tools[] 부분집합

  // ── 이벤트 ──
  eventSubscriptions?: string[];     // 호스트 이벤트 버스에서 수집할 이벤트
  notificationEvents?: Array<{       // OS 네이티브 알림으로 승격할 이벤트
    event: string;
    titleField?: string;             // data 내 점(.) 경로
    bodyField?: string;
  }>;
}
```

스키마 규칙(AJV 검증):

- 최상위 `additionalProperties: false` — 선언되지 않은 필드는 로드 거부.
- `id` 패턴 `^[a-zA-Z][a-zA-Z0-9._-]*$`, 길이 3–128.
- `tools[]`·`uiCallable[]` 항목 패턴 `^[a-zA-Z_][a-zA-Z0-9_]*$`, 길이 ≤64.
- `version` 은 anchored semver (prerelease/build 메타데이터 포함 가능).
- `ui[]` 는 `kind` 에 따라 필수 필드가 달라짐 (embedded-module → `entry`+`exportName`, embedded-page → `page`, info-card → 최소 필드).
- `toolSchemas[K].description` 은 최소 10자, `inputSchema.type` 은 `"object"` 상수.

### 예제: Meeting 플러그인 (현재 설치된 plugin.json 발췌)

```json
{
  "id": "meeting",
  "name": "LVIS Meeting",
  "version": "1.0.0",
  "installPolicy": "admin",
  "publisher": "LG Electronics IT",
  "startupTimeoutMs": 5000,
  "entry": "../../../node_modules/@lvis/plugin-meeting/dist/hostPlugin.js",
  "description": "회의 녹음·전사·요약 및 액션 아이템 추출",
  "tools": ["meeting_start", "meeting_push_chunk", "meeting_stop", "meeting_transcript", "meeting_sessions"],
  "capabilities": ["meeting-recorder"],
  "eventSubscriptions": ["meeting.summary.created", "meeting.ended"],
  "uiCallable": ["meeting_start", "meeting_push_chunk", "meeting_stop", "meeting_transcript", "meeting_sessions"]
}
```

### 필드 설명

#### id

- 플러그인 패키지 식별자. **시스템이 플러그인을 추적하는 유일한 키**.
- 현재 출시된 플러그인은 모두 flat 형식 (`meeting`, `pageindex`, `email`, `calendar`).
- 도트 형식 (`com.lge.meeting-recorder`) 도 허용되지만 **필수 아님**.
- UI 슬롯 ID, 이벤트 네임스페이스의 프리픽스로 사용 가능.
- ⚠️ **LLM tool name 과 별개** — `id` 에 도트가 있어도 `tools[]` 는 언더스코어만 허용.

#### version

- Anchored Semver. `1.0.0`, `1.0.0-beta.1`, `1.0.0+build.42` 등 허용.

#### entry

- 플러그인 루트에서 본 ESM 진입점 상대경로.
- 예: `../../../node_modules/@lvis/plugin-meeting/dist/hostPlugin.js`

#### tools

- LLM 에 노출되는 tool name 배열.
- `^[a-zA-Z_][a-zA-Z0-9_]*$` 필수. **도트 · 하이픈 금지**. 런타임 변환 없음.
- 위반 시 로드 시점에 거부됨.

#### description

- LLM 의 "비활성 플러그인 카탈로그" 및 UI 카드에 노출되는 1줄 요약.
- 미지정 시 `toolSchemas[].description` 들을 `/` 로 이어 fallback.

#### toolSchemas (선택)

- 각 도구의 설명 + JSON Schema draft-07 입력 스키마.
- 키는 `tools[]` 에 선언된 이름과 일치해야 함 (현재 런타임은 이 교차검증을 하지 않음 — [열린 TODO](#미구현--열린-todo) 참고).

#### keywords (선택)

- 키워드 엔진 등록 항목.
- `skillId` 는 `tools[]` 에 선언된 tool name 과 동일해야 함 (관례; 현재 강제 검증 없음 — [열린 TODO](#미구현--열린-todo) 참고).

#### capabilities (선택)

- 기능 태그. `ms-graph-consumer` 만 런타임에서 강제되고, 나머지는 선언 기반 discoverability 용. 자세히는 [capabilities 체계](#capabilities-체계).

#### startupTools (선택)

- 부팅 직후 실행할 도구 목록. 모든 항목은 `tools[]` 에 존재해야 하며, 불일치 시 매니페스트 로드 거부.

#### startupTimeoutMs (선택)

- 플러그인 `start()` 에 대한 하드 타임아웃 (ms). 범위: `1 ≤ n ≤ 60000`.
- 초과 시 해당 플러그인은 fail-soft 로 드롭되며, 호스트와 다른 플러그인은 계속 동작.
- 미지정 시 기본 경고 임계치 5000ms — 경고 로그만 출력됨.

#### ui (선택)

- 사이드바 UI 확장. [UI 확장](#ui-확장) 섹션 참고.

#### uiCallable (선택)

- 렌더러가 `lvis:plugins:call` IPC 로 직접 호출 허용되는 tool 이름 allowlist.
- 자세히는 [uiCallable 보안 경계](#uicallable-보안-경계).

#### eventSubscriptions (선택)

- 호스트가 **이벤트 버스에서 이 플러그인 쪽으로 전달**해야 할 이벤트 타입.
- ProactiveEngine 수집 경로에도 같이 wiring 됨.

#### notificationEvents (선택)

- OS 네이티브 알림으로 승격할 이벤트 선언.
- **독립 메커니즘** — `eventSubscriptions` 와 자동 연결되지 않음. 알림을 받으려면 같은 이벤트를 `eventSubscriptions` 에도 넣는 것이 안전.
- 여러 플러그인이 같은 `event` 를 선언하면 첫 번째만 등록되고 이후는 경고 후 무시.

#### installPolicy / dependencies / pluginAccess / publisher

- `installPolicy: "admin"` 플러그인은 관리자 정책 설치 대상이며 publish/승인 게이트를 통과해야 합니다.
- `installPolicy` 미지정은 `"user"`로 처리됩니다.
- `dependencies` 는 함께 설치/고려해야 하는 플러그인 관계이며 delivery mode가 아닙니다.
- `pluginAccess` 는 다른 플러그인의 tool/event 접근을 명시적으로 승인하는 grant입니다.
- 배포 경로는 marketplace 단일 경로이며 `deployment`, `deliveryMode`, `bundled`, `bundleDependencies`는 공개 매니페스트 필드로 사용하지 않습니다.

### 역참조 방지 체크리스트

1. `boot.ts`, `ipc-bridge.ts` 에서 플러그인 id 문자열을 직접 비교하지 않습니다.
2. 플러그인별 분기는 `capabilities` · `startupTools` · `eventSubscriptions` 중 하나로 선언합니다.
3. 신규 이벤트 연동은 `eventSubscriptions` 또는 `notificationEvents` 를 통해 호스트에 노출합니다.
4. 플러그인 리네임/교체 시 호스트 코드는 수정 없이 매니페스트만 갱신되어야 합니다.

---

## 호스트 플러그인 엔트리 (hostPlugin.ts)

호스트 플러그인은 플러그인의 JavaScript 진입점입니다. **모든 플러그인 초기화와 자기 등록이 여기서 이루어집니다.**

### 타입 정의

```typescript
type PluginToolHandler = (payload?: unknown) => Promise<unknown> | unknown;

interface RuntimePlugin {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  handlers: Record<string, PluginToolHandler>;  // key = tools[] 항목
}

interface PluginRuntimeContext {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
  hostApi: PluginHostApi;  // §HostApi 계약 참고
}

type RuntimePluginFactory =
  (ctx: PluginRuntimeContext) => Promise<RuntimePlugin> | RuntimePlugin;
```

### 기본 구조

```typescript
import type { PluginRuntimeContext, RuntimePlugin } from "@lvis/plugin-types";

export default async function createPlugin(
  context: PluginRuntimeContext,
): Promise<RuntimePlugin> {
  const { hostApi, config, log } = context;

  // 1. 초기화 로직
  //    - hostApi.getSecret(...) 로 API 키 조회
  //    - pluginRoot / hostRoot 기반 파일 경로 설정

  // 2. 키워드 등록 (매니페스트 keywords[] 선언이 있으면 자동 등록되지만,
  //    런타임 조건에 따라 동적으로 추가도 가능)
  hostApi.registerKeywords([
    { keyword: "회의록", skillId: "meeting_start" },
  ]);

  // 3. 이벤트 구독
  const dispose = hostApi.onEvent("calendar.event.created", (data) => {
    log("calendar event observed", data);
  });

  // 4. 종료 훅 (호스트가 before-quit 시 호출; handler 당 5초 cap)
  hostApi.onShutdown(async () => {
    dispose();
    await flushPendingWrites();
  });

  // 5. 핸들러 반환
  return {
    start: async () => { /* 선택 */ },
    stop:  async () => { /* 선택 */ },
    handlers: {
      meeting_start: async (payload) => { /* ... */ },
      meeting_stop:  async (payload) => { /* ... */ },
    },
  };
}
```

---

## HostApi 계약

플러그인이 호스트와 통신하는 유일한 통로가 **HostApi** 입니다. 현재 구현된 시그니처 (from `src/plugins/types.ts`):

```typescript
interface PluginHostApi {
  // 기본 통합
  registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
  emitEvent(eventType: string, data?: unknown): void;
  onEvent(eventType: string, handler: (data: unknown) => void): () => void; // 🔑 disposer 반환
  addTask(task: {
    title: string;
    description?: string;
    source: string;
    sourceRef?: string;
    priority?: "high" | "medium" | "low";
  }): void;
  saveNote(title: string, content: string): void;
  getSecret(key: string): string | null;

  // Microsoft Graph (capabilities: ["ms-graph-consumer"] 선언 필수)
  getMsGraphToken(): Promise<string | null>;
  startMsGraphAuth(openBrowser: (url: string) => Promise<void>): Promise<void>;
  isMsGraphAuthenticated(): boolean;
  getMsGraphAccount(): string | null;                 // ← 문자열 또는 null
  onMsGraphAuthChange(handler: () => void): void;      // ← 인자 없음

  // Sprint 1-A / 4-B 확장
  callLlm(prompt: string, options?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;
  logEvent(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  onShutdown(handler: () => void | Promise<void>): void;
}
```

### 1. registerKeywords()

키워드 엔진에 스킬 키워드를 등록합니다. 매니페스트 `keywords[]` 는 로드 시 자동으로 이 메서드를 호출합니다. 플러그인이 disable 될 때 자동으로 해제됩니다.

```typescript
hostApi.registerKeywords([
  { keyword: "회의록", skillId: "meeting_start" },
  { keyword: "녹음",   skillId: "meeting_start" },
]);
```

### 2. emitEvent()

플러그인이 이벤트를 발행합니다. 호스트 · 다른 플러그인 · ProactiveEngine 이 구독할 수 있습니다.

```typescript
hostApi.emitEvent("meeting.summary.created", { sessionId, title, summary });
```

이벤트 네이밍은 `{prefix}.{name}` 형식을 권장합니다 (예: `meeting.ended`, `email.action.needed`, `calendar.event.created`).

### 3. onEvent()

이벤트를 구독합니다. **반환값은 unsubscribe disposer** 이므로 수동 해제를 원한다면 호출하세요. 플러그인이 disable 될 때 런타임이 등록된 disposer 들을 자동 flush 합니다.

```typescript
const dispose = hostApi.onEvent("email.analyzed", (data) => {
  const { emailId, taskCount } = data as { emailId: string; taskCount: number };
  context.log(`email analyzed: ${emailId} (${taskCount})`);
});

// 필요 시 수동 해제
dispose();
```

### 4. addTask()

LVIS 태스크를 생성합니다. `priority` 는 `"high" | "medium" | "low"` 만 허용됩니다.

```typescript
hostApi.addTask({
  title: "계약 검토",
  description: "이메일(고객 계약서)에서 추출된 할 일",
  source: "email",
  sourceRef: "email-456",
  priority: "high",
});
```

### 5. saveNote()

`~/.lvis/notes/` 하위에 마크다운 메모를 저장합니다. 동일 제목은 덮어씁니다.

```typescript
hostApi.saveNote(`미팅-${sessionId.slice(0,8)}`, `# ${title}\n\n${summary}`);
```

### 6. getSecret()

암호화된 시크릿(주로 API 키)을 조회합니다.

| 키 | 설명 |
|----|------|
| `llm.apiKey.openai` | OpenAI API 키 |
| `llm.apiKey.anthropic` | Anthropic API 키 |
| `llm.apiKey.google` | Google API 키 |

### 7. Microsoft Graph 메서드 (capability gated)

아래 메서드들은 `manifest.capabilities` 에 `"ms-graph-consumer"` 가 **선언되어야** 호출 가능합니다. 미선언 플러그인이 호출 시 `capability not declared: ms-graph-consumer` 예외가 던져집니다.

```typescript
// 인증 상태
const signedIn: boolean = hostApi.isMsGraphAuthenticated();

// 계정 식별자 (문자열; 일반적으로 homeAccountId 또는 username)
const account: string | null = hostApi.getMsGraphAccount();

// OAuth 플로우 — 호스트가 생성한 URL 을 어떻게 열지 플러그인이 결정
await hostApi.startMsGraphAuth(async (url) => {
  // 렌더러가 URL 을 내부 뷰/외부 브라우저로 열도록 처리
  await shell.openExternal(url);
});

// 액세스 토큰 (자동 갱신 포함)
const token: string | null = await hostApi.getMsGraphToken();

// 인증 상태 변경 알림 (인자 없음; 현재 상태는 isMsGraphAuthenticated() 로 조회)
hostApi.onMsGraphAuthChange(() => {
  context.log(`auth changed → ${hostApi.isMsGraphAuthenticated()}`);
});
```

### 8. callLlm() — 호스트 LLM 공유

호스트가 관리하는 LLM 프로바이더를 통해 텍스트를 생성합니다. 플러그인이 직접 LLM 키를 보유하지 않고도 인텔리전트 기능을 구현할 수 있습니다.

```typescript
const summary = await hostApi.callLlm("이 회의록을 3줄로 요약해줘", {
  maxTokens: 400,
  systemPrompt: "너는 요약 전문 비서야.",
});
```

**제약**:
- **레이트 리밋**: 플러그인별 sliding window, 기본 **10분당 20회**. 초과 시 `callLlm rate-limit exceeded` 예외.
- **maxTokens 상한**: 4096 (호스트가 자동 clamp).
- 모든 호출은 AuditLogger 에 `tool_call` 이벤트로 기록됩니다 (`pluginId`, `promptLen`, `maxTokens`).
- 호스트 LLM 이 준비되지 않으면 에러.

### 9. logEvent()

`AuditLogger` 로 구조화된 로그 이벤트를 라우팅합니다. 자동으로 `plugin:<pluginId>` 컨텍스트, `sessionId="plugin"` 태그가 붙습니다.

```typescript
hostApi.logEvent("warn", "upstream timeout", { url, elapsedMs });
```

### 10. onShutdown()

Electron `before-quit` 직전에 호출되는 정리 훅을 등록합니다.

```typescript
hostApi.onShutdown(async () => {
  await pipeline.flush();
});
```

**제약**: 호스트가 각 handler 에 **5초 타임아웃**을 적용합니다. 느린 handler 는 로그로만 남고 quit 을 막지 않습니다. 플러그인의 `stop()` 보다 **먼저** 호출됩니다.

---

## 도구 명명 규칙

LVIS 플러그인에는 **세 개의 독립 네임스페이스**가 있습니다.

| 구분 | 대상 | 도트 허용? | 예시 |
|------|------|-----------|------|
| 플러그인 ID | `id` 필드 | ✅ | `meeting`, `com.lge.meeting-recorder` |
| LLM tool name | `tools[]`, `handlers` 키 | ❌ | `meeting_start` |
| 이벤트 이름 | `emitEvent()` / `onEvent()` | ✅ | `meeting.summary.created` |
| keywords.skillId | `keywords[].skillId` | ❌ (tool name 과 일치) | `meeting_start` |

런타임은 tool name 변환을 하지 않습니다. `tools: ["meeting.start"]` 같은 매니페스트는 로드 시점에 즉시 거부됩니다.

---

## toolSchemas 작성 가이드

`toolSchemas` 는 LLM function-calling 정확도를 높이는 JSON Schema (draft-07) 선언입니다.

규칙:
1. `description` 은 **최소 10자** (AJV 로 강제).
2. `inputSchema.type` 은 `"object"` 만 허용.
3. 필수 인자는 `required` 배열에 명시.
4. 가능한 `additionalProperties: false` 를 쓰는 편이 LLM 의 스키마 일탈을 줄입니다.
5. `required` 로 선언한 필드는 핸들러에서 재확인 (방어 코드).

```json
{
  "toolSchemas": {
    "meeting_start": {
      "description": "새 회의 녹음 세션을 시작합니다. sessionId 를 반드시 전달해야 합니다.",
      "inputSchema": {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "sessionId": { "type": "string", "description": "세션 고유 식별자" }
        },
        "required": ["sessionId"],
        "additionalProperties": false
      }
    }
  }
}
```

---

## uiCallable 보안 경계

`manifest.uiCallable[]` 은 렌더러 UI 가 `lvis:plugins:call` IPC 로 **직접** 호출할 수 있는 tool name 의 allowlist 입니다. 여기 없는 도구는 ConversationLoop 경로(permission / scope / expansion cap / ApprovalGate)를 반드시 거쳐야 합니다.

### 강제 규칙

1. **`uiCallable ⊂ tools`** — 목록에 없는 이름이 섞이면 매니페스트 로드 실패. 이 구조적 제약만 런타임에서 강제됩니다.
2. **도구 이름 제한 없음** — 접미사(`_delete`, `_send` 등)로 `uiCallable` 등록을 막지 않습니다. 어떤 도구든 플러그인의 판단에 따라 렌더러에서 직접 호출되도록 노출할 수 있습니다.
3. **파괴적 동작을 uiCallable로 노출하는 플러그인은 자체 UI에서 확인 다이얼로그를 구현해야 합니다** (예: "정말 삭제하시겠습니까?"). 호스트는 이를 강제하지 않으며, 코드 리뷰·마켓플레이스 심사 단계에서 검증합니다.
4. AI(ConversationLoop)가 개시한 도구 호출은 별개로 `ApprovalGate` / `PermissionManager` 의 확인 UX 를 거칩니다 — uiCallable 정책과 무관하게 그대로 유지됩니다.
5. 실제 위험 작업(파일시스템 민감 경로, 샌드박스 탈출 등)은 호스트의 `sensitive-paths.ts` · 샌드박스 계층에서 차단합니다. 이름 패턴이 아닌 작업의 실체로 막습니다.

### 예: Meeting 플러그인

```json
"tools":       ["meeting_start", "meeting_push_chunk", "meeting_stop", "meeting_transcript", "meeting_sessions"],
"uiCallable":  ["meeting_start", "meeting_push_chunk", "meeting_stop", "meeting_transcript", "meeting_sessions"]
```

`meeting_sessions` 는 LLM 전용으로 두고 UI 에서 빼도 됩니다 — 그 경우 렌더러는 ConversationLoop 을 거쳐야 호출 가능.

---

## capabilities 체계

capability 는 호스트가 특정 pluginId 를 몰라도 통합 지점을 결정하도록 돕는 **선언 태그**입니다. 네이밍은 kebab-case.

| capability | 의미 | 강제? | 예시 |
|-----------|------|-------|------|
| `meeting-recorder` | 실시간 음성 캡처 + STT | advisory | meeting |
| `mail-source` | 이메일 소스 연결 | advisory | email |
| `calendar-source` | 캘린더 소스 연결 | advisory | calendar |
| `background-watcher` | `startupTools` 로 폴러/워처 기동 | advisory | email, calendar |
| `worker-client` | 외부 프로세스(Python 등) 워커 래퍼 | advisory | pageindex |
| `knowledge-index` | 문서 인덱스/검색 제공 | advisory | pageindex |
| `ms-graph-consumer` | HostApi 의 MS Graph 메서드 사용 | **강제** (§B-5) | email, calendar |

현재 **런타임이 강제하는 capability 는 `ms-graph-consumer` 하나뿐**입니다. 미선언 플러그인이 `getMsGraphToken` / `startMsGraphAuth` / `isMsGraphAuthenticated` / `getMsGraphAccount` / `onMsGraphAuthChange` 중 하나라도 호출하면 `capability not declared: ms-graph-consumer` 예외가 발생합니다.

나머지는 discoverability 용 — 정책·UI·라우팅이 필요에 따라 조회합니다. enum 화 및 capability 기반 게이팅 확대는 [열린 TODO](#미구현--열린-todo) 참고.

---

## 이벤트 구독 및 OS 알림

### eventSubscriptions

호스트 이벤트 버스에서 수집할 이벤트를 선언합니다. 선언된 이벤트는 ProactiveEngine 수집 파이프라인으로도 들어갑니다.

```json
"eventSubscriptions": ["meeting.summary.created", "meeting.ended"]
```

플러그인이 `hostApi.onEvent(type, handler)` 로 직접 구독하는 것과는 **별개**입니다. `onEvent` 는 임의 이벤트를 구독할 수 있으며 매니페스트 선언과 무관하게 작동합니다.

### notificationEvents

OS 네이티브 알림으로 승격할 이벤트를 선언합니다.

```json
"notificationEvents": [
  { "event": "email.action.needed", "titleField": "subject", "bodyField": "summary" }
]
```

- `titleField` / `bodyField` 는 이벤트 데이터의 점(.) 경로. 미지정 시 title 은 event 이름, body 는 빈 문자열.
- 동일 event 가 여러 플러그인에서 선언되면 **첫 번째만 등록**되고 나머지는 경고 후 무시.
- `notificationEvents` 는 `eventSubscriptions` 과 **자동 연결되지 않음**. 알림이 실제로 뜨려면 해당 이벤트가 호스트 이벤트 버스에 emit 되어야 합니다. 안전한 기본값은 같은 이벤트를 `eventSubscriptions` 에도 넣는 것입니다 (현재 런타임은 이를 강제하지 않음 — [열린 TODO](#미구현--열린-todo) 참고).

---

## Marketplace 배포 및 무결성

플러그인 개발자는 매니페스트 sidecar 서명을 직접 생성하지 않습니다. 배포 검증은 marketplace upload/publish 단계에서 수행되고, LVIS 호스트는 marketplace가 발급한 artifact envelope을 설치 시점에 ed25519로 검증합니다.

### installPolicy 정책

| `installPolicy` | 게시/설치 정책 |
|--------------|-----------|
| `"admin"` | marketplace admin review 후 공개. 호스트는 서명된 artifact envelope과 설치 영수증을 검증합니다. |
| `"user"` (또는 미지정) | marketplace publish 경로로 게시. 호스트는 동일하게 envelope과 설치 영수증을 검증합니다. |

### 검증 메커니즘

- 설치 시점: artifact zip bytes의 `artifact_sha256` 및 marketplace envelope signature 검증.
- 로드 시점: 설치 시 기록한 `install-receipt.json` 의 파일 해시와 디스크 파일을 비교해 로컬 변조를 차단.
- trust anchor는 SDK가 아니라 host runtime의 `src/plugins/marketplace-keys.ts` 에 있습니다.
- 개발 중 직접 manifest path를 로드하는 테스트/dev 경로는 marketplace install receipt가 없으므로 배포 검증 경로와 분리됩니다.

---

## 레이트 리밋 · 예산

| 대상 | 한도 | 적용 지점 |
|------|------|----------|
| `callLlm` — 플러그인별 | **20회 / 10분** (sliding window) | `src/boot/conversation.ts#createCallLlmForPlugin` |
| `callLlm` maxTokens | **≤ 4096** (초과값은 clamp) | 동일 |
| `startupTimeoutMs` | **1 ≤ n ≤ 60000 ms** (선언 시) / 기본 경고 임계치 5000ms | `src/plugins/runtime.ts#startAll` |
| `onShutdown` handler | 각 handler 당 **5초 캡** (초과 시 로그만) | `src/boot.ts` |

비-플러그인 호출자(예: ProactiveEngine 자체 briefing)는 `createCallLlm` 경로를 사용하고 레이트 리밋이 적용되지 않습니다.

---

## IPC/RPC 경계

### 원칙: 플러그인은 IPC/RPC 를 직접 사용하지 않는다

플러그인 번들에서 `ipcRenderer` / `ipcMain` 을 **절대 import 하지 마세요**. 모든 통신은 정해진 경계를 통해 이루어집니다.

| 방향 | 방법 | 비고 |
|------|------|------|
| LLM → 플러그인 도구 | ToolRegistry 경유 (자동) | 플러그인 코드 불필요 |
| Renderer UI → 플러그인 도구 | `lvis:plugins:call(toolName, payload)` | `uiCallable` allowlist 강제 |
| 플러그인 → 호스트 | `PluginHostApi` 직접 호출 | `context.hostApi.*` |
| 플러그인 → 플러그인 | `emitEvent` / `onEvent` | 직접 참조 금지 |

### UI 모듈에서의 도구 호출

Renderer 에 마운트되는 UI 모듈은 전달받은 `hostApi.callTool(...)` 을 씁니다. 이 `hostApi` 는 플러그인 팩토리 context 의 `hostApi` 와 **별개** (UI 전용 얕은 래퍼)입니다.

```javascript
// ✅ 올바름
export default async function MyPluginUI({ container, hostApi }) {
  const result = await hostApi.callTool("meeting_start", { sessionId: "sess-001" });
}

// ❌ 금지
import { ipcRenderer } from "electron";          // 절대 금지
ipcRenderer.invoke("lvis:some:channel", ...);    // 절대 금지
```

---

## UI 확장

```typescript
interface PluginUiExtension {
  id: string;
  slot: "sidebar";                           // 현재는 sidebar 만
  kind: "embedded-module" | "embedded-page" | "info-card";
  displayName?: string;
  title: string;
  description?: string;
  defaults?: Record<string, unknown>;
  entry?: string;        // embedded-module 에서 필수
  exportName?: string;   // embedded-module 에서 필수
  page?: string;         // embedded-page 에서 필수
}
```

(Vanilla / React 예제는 이전 버전과 동일하게 유지되며, 핵심은 `hostApi.callTool(...)` 을 통해서만 도구를 호출하는 것입니다. 자세한 예제는 각 내장 플러그인 저장소를 참고하세요.)

---

## 빌드 설정

LVIS 플러그인은 TypeScript + `tsup` + `vitest` 조합을 권장합니다. 예시 `package.json` / `tsup.config.ts` / `tsconfig.json` 은 별도 플러그인 저장소(`lvis-plugin-meeting` 등)의 템플릿을 참고하세요. 핵심 제약:

- `tsup` `splitting: false` (매니페스트 `entry` 경로가 결정론적이어야 함)
- CommonJS + ESM 이중 출력 가능 (호스트는 ESM import)
- Node 18+ 타겟

---

## 테스팅

Vitest 단위 테스트에서 HostApi 를 모킹할 때는 **현재 인터페이스 전체**를 커버해야 타입 오류가 나지 않습니다.

```typescript
import { vi } from "vitest";
import type { PluginHostApi } from "@lvis/plugin-types";

const hostApi: PluginHostApi = {
  registerKeywords: vi.fn(),
  emitEvent: vi.fn(),
  onEvent: vi.fn(() => () => {}),         // disposer 반환
  addTask: vi.fn(),
  saveNote: vi.fn(),
  getSecret: vi.fn(() => null),
  getMsGraphToken: vi.fn(async () => null),
  startMsGraphAuth: vi.fn(async (_openBrowser) => {}),
  isMsGraphAuthenticated: vi.fn(() => false),
  getMsGraphAccount: vi.fn(() => null),    // string | null
  onMsGraphAuthChange: vi.fn(),             // () => void handler
  callLlm: vi.fn(async () => "mock"),
  logEvent: vi.fn(),
  onShutdown: vi.fn(),
};
```

---

## 설치 및 배포

### 디렉토리 구조

```
lvis-app/plugins/installed/{plugin-id}/
  plugin.json          ← 매니페스트 (AJV 검증 대상)
  install-receipt.json ← marketplace 설치 시 기록된 파일 해시 영수증
  (+ 필요 시 번들 파일)
```

### registry.json

```json
{
  "version": 1,
  "plugins": [
    { "id": "meeting",   "manifestPath": "plugins/installed/meeting/plugin.json",   "enabled": true },
    { "id": "ms-graph",  "manifestPath": "plugins/installed/ms-graph/plugin.json",  "enabled": true },
    { "id": "pageindex", "manifestPath": "plugins/installed/pageindex/plugin.json", "enabled": true }
  ]
}
```

### 플러그인 제거

1. `registry.json` 에서 `enabled: false` 로 두거나 항목 삭제.
2. 런타임 disable 시 `PluginRuntime.disable(pluginId)` 호출:
   - `stop()` 호출
   - method handler 제거
   - 플러그인이 등록한 disposer 들을 flush
   - keywordEngine / toolRegistry / conversationLoop 의 `onDisable` 콜백 호출
   - `registry.json` 원자적 갱신
3. `managed` 플러그인은 `PluginDeploymentGuard` 가 user-initiated disable 을 차단합니다.

---

## 완전한 예제

Meeting / Microsoft 365 (Outlook 메일+캘린더) / PageIndex 의 실제 플러그인 소스는 모두 `lvis-project/` 아래 형제 저장소에 있습니다:

- `lvis-plugin-meeting`
- `lvis-plugin-ms-graph` (구 `lvis-plugin-email` + `lvis-plugin-calendar` 통합)
- `lvis-plugin-pageindex`

각 저장소의 `src/hostPlugin.ts` 를 현행 HostApi 사용 패턴 레퍼런스로 삼으세요.

---

## 체크리스트

- [ ] **매니페스트**
  - [ ] `id`, `name`, `version`, `entry`, `tools` 필수 필드
  - [ ] `description` 1줄 요약 (LLM 카탈로그 품질)
  - [ ] `tools[]` 언더스코어 패턴, `^[a-zA-Z_][a-zA-Z0-9_]*$`
  - [ ] 필요 시 `capabilities`, `ms-graph-consumer` 등
  - [ ] `uiCallable ⊂ tools` (파괴적 도구라도 등록 가능 — 플러그인 자체 확인 UX 필수)
  - [ ] `startupTimeoutMs` (start 가 느릴 수 있다면)
  - [ ] `toolSchemas` description ≥ 10자
- [ ] **hostPlugin.ts**
  - [ ] `PluginRuntimeContext` 타입 사용
  - [ ] `onEvent` disposer 보관 or `onShutdown` 에서 정리
  - [ ] `stop()` 에서 파이프라인 flush (또는 `onShutdown` 훅)
  - [ ] Electron IPC 직접 사용 금지
- [ ] **Marketplace 배포**
  - [ ] zip artifact가 `plugin.json` 과 빌드 산출물을 포함
  - [ ] marketplace publish/upload API 또는 UI로 게시
  - [ ] `installPolicy: "admin"` 플러그인은 admin review 완료 후 공개
- [ ] **테스트**
  - [ ] HostApi 모킹 시 `callLlm` / `logEvent` / `onShutdown` 포함
  - [ ] `onEvent` 모킹이 disposer 를 반환하도록

---

## 미구현 · 열린 TODO

아래 항목은 가이드·스키마·정책상 정의되어 있지만 **현재 런타임에서 강제되지 않는** 사항이거나 아직 도구/스크립트가 없는 사항입니다. 향후 스프린트에서 좁힐 대상.

1. **`keywords[].skillId ∈ tools[]` 교차 검증** — AJV 및 `readManifest` 에서 강제되지 않음. 잘못된 skillId 가 키워드 엔진에 등록될 수 있음.
2. **`toolSchemas` 키 ⊂ `tools[]` 교차 검증** — 현재는 불일치 시 조용히 무시.
3. **`notificationEvents.event ⊂ eventSubscriptions` 교차 검증** — 선언했지만 구독하지 않아 알림이 절대 뜨지 않는 상태 경고가 없음.
4. **`capabilities` enum 화** — 현재 `ms-graph-consumer` 만 런타임에서 강제. 나머지는 자유 문자열. 정책 게이트 확장 필요 (예: `worker-client` 선언 플러그인만 Python runtime 사용 허용).
5. **`eventSubscriptions` 민감 이벤트 allowlist / 네임스페이스 정책** — 임의 플러그인이 `email.*`, `calendar.*` 같은 타 플러그인 네임스페이스를 구독할 수 있음.
6. **프로덕션 marketplace 공개키 회전** — `src/plugins/marketplace-keys.ts` 의 POC 키는 프로덕션 릴리스 전 실제 운영 키로 교체해야 함.
7. **`ui[]` kind 별 필드 규약** 은 스키마가 담고 있지만, 실제 로더는 엄격한 fallback 처리(`entry ?? page`)를 하므로 일부 오탈자가 silent 하게 넘어갈 여지가 남음.
8. **`startupTools` 실패 정책** — 항목 하나가 실패해도 전체 플러그인은 계속 로드됨 (fail-soft). 명시적 요구 실패를 원하는 도구는 직접 throw 로직을 가져야 함.

---

## 참고 자료

- [아키텍처 문서 §9 — Plugin System & UI Extension](../architecture/architecture.md#9-plugin-system--ui-extension)
- [CLAUDE.md](../../CLAUDE.md)
- `src/plugins/types.ts`, `src/plugins/runtime.ts`, `src/plugins/marketplace.ts`, `src/plugins/plugin-install-receipt.ts`, `src/plugins/publisher-keys.ts`
- `src/boot.ts`, `src/boot/conversation.ts` (callLlm 레이트리밋), `src/boot/plugins.ts` (notification / eventSubscriptions)
- `schemas/plugin.schema.json`
- Meeting / Email / Calendar / PageIndex 플러그인 저장소 (현행 사용 예제)
