# LVIS 플러그인 개발 가이드

> **상태**: 최종 버전 (2026-04-18)
> **대상**: LVIS 플러그인 개발자
> **선행 읽음**: [아키텍처 문서 §9](../architecture/architecture.md#9-plugin-system--ui-extension) · [CLAUDE.md](../../CLAUDE.md)

---

## 목차

1. [플러그인이란](#플러그인이란)
2. [플러그인 매니페스트 (plugin.json)](#플러그인-매니페스트-pluginjson)
3. [호스트 플러그인 엔트리 (hostPlugin.ts)](#호스트-플러그인-엔트리-hostplugints)
4. [HostApi 계약](#hostapi-계약)
5. [도구 명명 규칙](#도구-명명-규칙)
6. [toolSchemas 작성 가이드](#toolschemas-작성-가이드)
7. [IPC/RPC 경계](#ipcrpc-경계)
8. [UI 확장](#ui-확장)
9. [빌드 설정](#빌드-설정)
10. [테스팅](#테스팅)
11. [설치 및 배포](#설치-및-배포)
12. [완전한 예제](#완전한-예제)
13. [향후 계획 (미구현)](#향후-계획-미구현)

---

## 플러그인이란

LVIS 플러그인은 **자기 등록 방식의 모듈식 확장**입니다. 호스트 앱이 플러그인 특정 코드를 갖지 않고, 플러그인이 시작 시 `context.hostApi`를 통해 자신을 등록합니다.

### 핵심 원칙

1. **호스트는 플러그인을 몰라야 함** — 모든 플러그인 통합은 HostApi를 통해 이루어짐
2. **독립적 생명주기** — 플러그인 추가/제거 시 호스트를 수정하지 않음
3. **명확한 계약** — PluginManifest + HostApi 인터페이스로 정의됨

### 플러그인의 역할

| 역할 | 설명 | 예시 |
|------|------|------|
| **스킬 제공** | 키워드 등록 및 도구 핸들러 | "회의록", "이메일", "문서 검색" |
| **이벤트 생산** | 호스트/플러그인이 구독할 이벤트 발행 | `meeting.summary.created` |
| **데이터 통합** | 외부 시스템의 데이터를 LVIS에 끌어옴 | 이메일, 회의 기록, 문서 인덱싱 |
| **UI 제공** | 사이드바 슬롯에 React/vanilla JS 컴포넌트 | 회의 제어, 이메일 인증, 검색 UI |

---

## 플러그인 매니페스트 (plugin.json)

플러그인 매니페스트는 호스트가 플러그인을 발견하고 로드하기 위한 메타데이터입니다.

### 전체 스키마

```typescript
interface PluginManifest {
  // 필수 필드
  id: string;              // 패키지 식별자 (도트 형식 권장, 예: "com.lge.meeting-recorder")
  name: string;            // 사람이 읽을 수 있는 이름
  version: string;         // Semantic versioning (예: "1.0.0")
  entry: string;           // hostPlugin.ts 진입점 경로
  tools: string[];         // LLM tool name 배열 (언더스코어 전용, 도트 금지)

  // 선택 필드
  toolSchemas?: Record<string, {
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;                                        // 도구별 입력 스키마 (LLM function calling용)
  config?: Record<string, unknown>;          // 기본 설정값
  keywords?: Array<{ keyword: string; skillId: string }>;  // 키워드 선언
  ui?: PluginUiExtension[];                  // UI 슬롯 확장
  capabilities?: string[];                   // 기능 태그 (예: "worker-client", "calendar-source")
  startupTools?: string[];                   // 부팅 시 자동 실행할 tools[] 항목
  eventSubscriptions?: string[];             // 호스트가 수집/구독할 이벤트 타입
  deployment?: "managed" | "user";           // 배포 유형
  publisher?: string;                        // 퍼블리셔 식별자
}
```

### 예제: 미팅 플러그인

```json
{
  "id": "com.lge.meeting-recorder",
  "name": "LVIS Meeting",
  "version": "1.0.0",
  "entry": "../../../node_modules/@lvis/plugin-meeting/dist/hostPlugin.js",
  "tools": [
    "meeting_start",
    "meeting_push_chunk",
    "meeting_stop",
    "meeting_transcript",
    "meeting_sessions"
  ],
  "toolSchemas": {
    "meeting_start": {
      "description": "회의 세션을 시작합니다.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": { "type": "string", "description": "세션 고유 ID" }
        },
        "required": ["sessionId"]
      }
    },
    "meeting_stop": {
      "description": "진행 중인 회의 세션을 종료하고 요약을 생성합니다.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": { "type": "string", "description": "종료할 세션 ID" }
        },
        "required": ["sessionId"]
      }
    }
  },
  "config": {
    "intermediateEveryFinalSegments": 1
  },
  "ui": [
    {
      "id": "meeting-control",
      "slot": "sidebar",
      "kind": "embedded-module",
      "displayName": "미팅",
      "title": "Meeting Recorder",
      "description": "회의 세션 시작/청크 주입/종료/전사 조회를 테스트합니다.",
      "entry": "../../../node_modules/@lvis/plugin-meeting/dist/ui/meeting-control.js"
    }
  ]
}
```

### 필드 설명

#### id
- **플러그인 패키지 식별자** — 시스템이 플러그인을 추적하는 고유 키
- **도트(`.`) 형식 권장**
- 예: `com.lge.meeting-recorder`, `com.lge.email`, `page-index`
- UI 슬롯 ID, 이벤트 네임스페이스의 프리픽스로 사용
- ⚠️ **LLM tool name과 별개** — id에 도트가 있어도 tools[]는 반드시 언더스코어여야 함

#### name
- 사람이 읽을 수 있는 플러그인 이름
- 설정 UI, 마켓플레이스에서 표시

#### version
- Semantic versioning: `MAJOR.MINOR.PATCH`
- 플러그인 업데이트 추적에 사용

#### entry
- 호스트 플러그인 JavaScript 파일의 경로
- 상대 경로 (플러그인 설치 위치 기준)
- 예: `../../../node_modules/@lvis/plugin-meeting/dist/hostPlugin.js`

#### tools
- **LLM에 노출되는 도구 이름(tool name) 배열**
- **반드시 `^[a-zA-Z_][a-zA-Z0-9_]*$` 패턴 (첫 글자는 영문자/언더스코어, 이후 영문자/숫자/언더스코어) — 도트(`.`)·하이픈(`-`) 금지**
- 예: `meeting_start`, `email_list`, `index_scan`
- 런타임이 이 값을 그대로 LLM tool name으로 사용하며 dot-to-underscore 변환을 수행하지 않음
- 로드 시 패턴 검증을 수행하며, 위반 시 플러그인 로드 거부

#### toolSchemas (선택)
- 각 도구의 설명과 입력 스키마를 선언합니다.
- LLM function calling에서 도구를 정확히 호출하도록 안내합니다.
- 키는 `tools[]`에 선언된 이름과 일치해야 합니다.
- 자세한 작성 방법은 [toolSchemas 작성 가이드](#toolschemas-작성-가이드) 참고

#### config (선택)
- 기본 설정값
- 사용자가 호스트 설정 UI에서 수정 가능
- 플러그인은 `context.config`로 접근

#### keywords (선택)
- 키워드 엔진이 인식할 스킬 키워드
- 사용자 입력 분류 시 사용
- `skillId`는 매니페스트 `tools` 배열에 있는 도구 이름과 동일한 언더스코어 형식 사용
- 예: `{ keyword: "회의록", skillId: "meeting_start" }`

#### ui (선택)
- 호스트 UI의 특정 슬롯에 확장 UI를 마운트
- 자세히는 [UI 확장](#ui-확장) 섹션 참고

#### capabilities (선택)
- 호스트가 플러그인 구현체를 직접 알지 않도록 하는 **기능 선언 태그**입니다.
- 예: `worker-client`, `knowledge-index`, `background-watcher`, `calendar-source`
- 호스트는 특정 plugin id 대신 capability를 조회해 통합 지점을 결정합니다.

#### startupTools (선택)
- 앱 부팅 직후 실행해야 하는 도구 목록입니다.
- 항목은 반드시 `tools` 배열에 선언되어 있어야 하며, 불일치 시 플러그인 로드가 거부됩니다.
- 예: `["email_start_watcher", "calendar_start_watcher"]`

#### eventSubscriptions (선택)
- 호스트가 이벤트 버스에서 수집해야 할 이벤트 타입 목록입니다.
- 하드코딩된 `onEvent("...")` 대신 선언 기반으로 wiring됩니다.
- `mail-source` capability를 선언한 플러그인은 `*.new` 이벤트를 추가하면
  호스트가 네이티브 알림을 자동 등록합니다. (예: `email.new`)

### 역참조 방지 체크리스트

1. `boot.ts`, `ipc-bridge.ts`에서 플러그인 id 문자열을 직접 비교하지 않습니다.
2. 플러그인별 분기가 필요하면 `capabilities` 또는 `startupTools`로 선언합니다.
3. 신규 이벤트 연동은 `eventSubscriptions`를 통해 호스트에 노출합니다.
4. 플러그인 리네임/교체 시 호스트 코드는 수정 없이 매니페스트만 갱신되어야 합니다.

---

## 호스트 플러그인 엔트리 (hostPlugin.ts)

호스트 플러그인은 플러그인의 JavaScript 진입점입니다. **모든 플러그인 초기화와 자기 등록이 여기서 이루어집니다.**

### 타입 정의

```typescript
// PluginToolHandler: 도구 핸들러 함수 타입
type PluginToolHandler = (payload?: unknown) => Promise<unknown> | unknown;

// RuntimePlugin: createPlugin이 반환하는 객체
interface RuntimePlugin {
  start?: () => Promise<void> | void;    // 플러그인 시작 시 호출 (선택)
  stop?: () => Promise<void> | void;     // 플러그인 정지 시 호출 (선택)
  handlers: Record<string, PluginToolHandler>;  // key = tools[]의 도구 이름
}
```

### 기본 구조

```typescript
import type { PluginToolHandler } from "@lvis/plugin-types";

type HostPluginContext = {
  pluginId: string;          // 플러그인 ID (예: "com.lge.meeting-recorder")
  pluginRoot: string;        // 플러그인 루트 디렉토리 경로
  hostRoot: string;          // 호스트 앱 루트 디렉토리 경로
  config?: Record<string, unknown>;  // 매니페스트에서 지정된 config
  log: (message: string, meta?: unknown) => void;  // 로깅 함수
  hostApi: {
    registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
    emitEvent(eventType: string, data?: unknown): void;
    onEvent(eventType: string, handler: (data: unknown) => void): void;
    addTask(task: { title: string; description?: string; source: string; sourceRef?: string; priority?: string }): void;
    saveNote(title: string, content: string): void;
    getSecret(key: string): string | null;
    getMsGraphToken(): Promise<string | null>;
    startMsGraphAuth(): Promise<void>;
    isMsGraphAuthenticated(): boolean;
    getMsGraphAccount(): { name?: string; email?: string } | null;
    onMsGraphAuthChange(handler: (authenticated: boolean) => void): void;
  };
};

// 플러그인 팩토리 함수
export default async function createPlugin(context: HostPluginContext) {
  const { hostApi } = context;

  // 1. 초기화 로직 (상태 복원, 서비스 시작 등)
  // ...

  // 2. 키워드 등록 (hostApi)
  hostApi.registerKeywords([
    { keyword: "회의록", skillId: "meeting_start" },
    { keyword: "녹음", skillId: "meeting_start" },
  ]);

  // 3. 이벤트 핸들러 등록
  recorder.on("final-summary", ({ sessionId, title, summary }) => {
    hostApi.saveNote(`미팅-${sessionId}`, `# ${title}\n${summary}`);
    hostApi.emitEvent("meeting.summary.created", { sessionId, title });
  });

  // 4. 도구 핸들러 반환
  return {
    handlers: {
      "meeting_start": async (payload?: unknown) => {
        // ...
      },
      "meeting_stop": async (payload?: unknown) => {
        // ...
      },
    },
  };
}
```

### 단계별 구현 패턴

#### 단계 1: 의존성 주입 처리

```typescript
export default async function createPlugin(context: HostPluginContext) {
  const { hostApi, config, log } = context;

  // API 키 조회 (config 또는 hostApi.getSecret 우선순위)
  const apiKey = (config?.openaiApiKey as string)
    ?? hostApi.getSecret("llm.apiKey.openai")
    ?? undefined;

  // 저장 경로 설정
  const storageDir = (config?.storageDir as string) 
    ?? join(context.hostRoot, ".plugin-data");

  log("plugin initialized", { apiKey: !!apiKey, storageDir });
  // ...
}
```

#### 단계 2: 서비스/상태 초기화

```typescript
// 세션 지속성
const sessionStore = new SessionStore(storageDir);

// 메인 파이프라인/엔진 생성
const pipeline = new MeetingPipeline({
  sttProvider: apiKey ? new OpenAIWhisperSttProvider({ apiKey }) : new MockSttProvider(),
  summaryProvider: apiKey ? new OpenAISummaryProvider({ apiKey }) : new MockSummaryProvider(),
  log: context.log,
  onSessionUpdate: (session) => {
    sessionStore.save({...});
  },
});

// 크래시 복구
for (const session of sessionStore.listUnfinished()) {
  pipeline.restoreSession(session);
  context.log(`recovered session: ${session.sessionId}`);
}
```

#### 단계 3: 키워드 등록

```typescript
hostApi.registerKeywords([
  { keyword: "회의록", skillId: "meeting_start" },
  { keyword: "녹음", skillId: "meeting_start" },
  { keyword: "미팅", skillId: "meeting_start" },
]);
```

**주의**: `skillId`는 매니페스트의 `tools` 배열에 있는 도구 이름(언더스코어 형식)과 일치해야 합니다.

#### 단계 4: 이벤트 핸들러 등록

```typescript
recorder.on("final-summary", ({ sessionId, title, summary }) => {
  // 메모 자동 저장
  hostApi.saveNote(
    `미팅-${sessionId.slice(0, 8)}`,
    `# ${title}\n\n${summary}`
  );

  // 이벤트 발행 (다른 플러그인/호스트 구독 가능)
  hostApi.emitEvent("meeting.summary.created", {
    sessionId,
    title,
    summary,
  });
});

recorder.on("error", ({ sessionId, error }) => {
  context.log(`meeting error: ${sessionId}`, error);
  hostApi.emitEvent("meeting.error", {
    sessionId,
    error: (error as Error).message,
  });
});
```

#### 단계 5: 도구 핸들러 정의 및 반환

```typescript
return {
  start: async () => {
    // 플러그인 시작 시 호출 (선택)
    context.log("plugin started");
  },

  stop: async () => {
    // 플러그인 정지 시 호출 (선택)
    context.log("plugin stopped");
  },

  handlers: {
    "meeting_start": async (payload?: unknown) => {
      const body = (payload ?? {}) as { sessionId?: string };
      if (!body.sessionId) throw new Error("sessionId is required");

      recorder.start(body.sessionId);
      hostApi.emitEvent("meeting.started", { sessionId: body.sessionId });
      return { sessionId: body.sessionId, started: true };
    },

    "meeting_stop": async (payload?: unknown) => {
      const body = (payload ?? {}) as { sessionId?: string };
      if (!body.sessionId) throw new Error("sessionId is required");

      await recorder.stop(body.sessionId);
      hostApi.emitEvent("meeting.ended", { sessionId: body.sessionId });

      const final = finalBySession.get(body.sessionId);
      if (final?.actionItems.length) {
        for (const item of final.actionItems) {
          hostApi.addTask({
            title: item.slice(0, 100),
            description: `미팅(${final.title})에서 생성된 액션 아이템`,
            source: "meeting",
            sourceRef: body.sessionId,
            priority: "medium",
          });
        }
      }

      return final;
    },
  },
};
```

---

## HostApi 계약

플러그인이 호스트와 통신하는 유일한 통로가 **HostApi**입니다. 현행 구현된 메서드는 다음과 같습니다.

### 1. registerKeywords()

키워드 엔진에 스킬 키워드를 등록합니다. 사용자 입력이 분류될 때 매칭됩니다.

```typescript
hostApi.registerKeywords([
  { keyword: "회의록", skillId: "meeting_start" },
  { keyword: "녹음", skillId: "meeting_start" },
]);
```

**주의사항**:
- `skillId`는 매니페스트 `tools` 배열에 있는 언더스코어 형식 도구 이름이어야 함
- 플러그인 제거 시 자동으로 해제됨
- 키워드는 한국어, 영문, 혼합 모두 지원

### 2. emitEvent()

플러그인이 이벤트를 발행합니다. 호스트나 다른 플러그인이 구독할 수 있습니다.

```typescript
hostApi.emitEvent("meeting.summary.created", {
  sessionId: "sess-123",
  title: "팀 회의",
  summary: "...",
});
```

**이벤트 네이밍**:
- 형식: `{pluginId}.{eventName}`
- 예: `meeting.summary.created`, `email.action.needed`, `index.scan.complete`

**흔한 이벤트**:
| 플러그인 | 이벤트 | 의미 |
|---------|--------|------|
| meeting | `meeting.started` | 녹음 시작 |
| meeting | `meeting.ended` | 녹음 종료 |
| meeting | `meeting.summary.created` | 최종 요약 완료 |
| meeting | `meeting.error` | 오류 발생 |
| email | `email.action.needed` | 액션 필요 이메일 발견 |
| email | `email.analyzed` | 이메일 분석 완료 |
| index | `index.scan.complete` | 문서 인덱싱 완료 |

### 3. onEvent()

이벤트를 구독합니다. 플러그인이 다른 플러그인의 이벤트에 반응할 수 있습니다.

```typescript
hostApi.onEvent("email.analyzed", (data: unknown) => {
  const { emailId, taskCount } = data as {
    emailId: string;
    taskCount: number;
  };
  context.log(`email analyzed: ${emailId} (${taskCount} tasks)`);
});
```

### 4. addTask()

LVIS 태스크를 자동 생성합니다. 이메일에서 추출한 할 일, 미팅의 액션 아이템 등이 대상입니다.

```typescript
hostApi.addTask({
  title: "계약 검토",
  description: "이메일(고객 계약서)에서 추출된 할 일",
  source: "email",           // 플러그인 ID
  sourceRef: "email-456",    // 소스 문서 ID (검색 시 역추적 가능)
  priority: "high",          // "high" | "medium" | "low"
});
```

**필드 설명**:
- `title`: 태스크 제목 (최대 100자 권장)
- `description`: 상세 설명
- `source`: 플러그인 ID (예: "meeting", "email", "index")
- `sourceRef`: 소스 문서/세션 ID (검색할 때 역추적 가능)
- `priority`: "high" | "medium" | "low"

### 5. saveNote()

사용자의 `notes/` 디렉토리에 메모를 저장합니다. 플러그인이 생성한 데이터(요약, 분석 결과)를 영구 보관합니다.

```typescript
hostApi.saveNote(
  `미팅-${sessionId.slice(0, 8)}-${title}`,
  `# ${title}\n> 세션: ${sessionId}\n> 시간: ${createdAt}\n\n${summary}`
);
```

**주의사항**:
- 첫 번째 인자는 파일명 (`.md` 자동 추가됨)
- 두 번째 인자는 마크다운 콘텐츠
- 파일은 `~/.lvis/notes/` 저장됨
- 중복 호출 시 기존 파일 덮어씀

### 6. getSecret()

설정에 저장된 암호화된 API 키를 조회합니다.

```typescript
const openaiKey = hostApi.getSecret("llm.apiKey.openai");

if (!openaiKey) {
  context.log("API 키가 설정되지 않았습니다");
  // Fallback: mock provider 사용
}
```

**흔한 시크릿 키**:
| 키 | 설명 |
|----|------|
| `llm.apiKey.openai` | OpenAI API 키 |
| `llm.apiKey.anthropic` | Anthropic API 키 |
| `llm.apiKey.google` | Google API 키 |

### 7. Microsoft Graph 메서드

Microsoft 365 연동이 필요한 플러그인(이메일, 캘린더 등)을 위한 인증 메서드입니다.

```typescript
// 현재 인증 상태 확인
const isAuth = hostApi.isMsGraphAuthenticated();

// 로그인한 계정 정보
const account = hostApi.getMsGraphAccount();
// → { name?: string; email?: string } | null

// OAuth 인증 플로우 시작 (브라우저 팝업)
await hostApi.startMsGraphAuth();

// 액세스 토큰 조회 (자동 갱신 포함)
const token = await hostApi.getMsGraphToken();
// → string | null

// 인증 상태 변경 구독
hostApi.onMsGraphAuthChange((authenticated) => {
  context.log(`MS Graph auth changed: ${authenticated}`);
});
```

**사용 패턴**:
```typescript
export default async function createPlugin(context: HostPluginContext) {
  const { hostApi } = context;

  return {
    handlers: {
      "email_login": async () => {
        await hostApi.startMsGraphAuth();
        return { authenticated: hostApi.isMsGraphAuthenticated() };
      },

      "email_list": async (payload?: unknown) => {
        const token = await hostApi.getMsGraphToken();
        if (!token) throw new Error("먼저 로그인해주세요 (email_login)");
        // token으로 Graph API 직접 호출
        // ...
      },
    },
  };
}
```

---

## 도구 명명 규칙

LVIS 플러그인에는 **두 개의 독립적인 명명 네임스페이스**가 있습니다.

### 1. 플러그인 ID (패키지 식별자 네임스페이스)

`plugin.json`의 `id` 필드는 플러그인 패키지를 식별하는 값입니다. **도트(`.`) 형식이 권장됩니다.**

```json
{
  "id": "com.lge.meeting-recorder"
}
```

플러그인 ID는 시스템이 플러그인을 추적·관리하는 데 사용되며 LLM에 직접 노출되지 않습니다.

### 2. LLM tool name (도구 이름 네임스페이스)

`tools[]` 배열과 `handlers` 객체 키는 **LLM이 직접 호출하는 이름**입니다. LVIS의 canonical form은 lower snake_case (`meeting_start`, `index_scan`)이며, 런타임은 manifest 값을 그대로 등록합니다. **도트(`.`)나 하이픈(`-`)을 언더스코어로 바꿔주지 않습니다.**

```json
{
  "tools": ["meeting_start", "meeting_stop", "meeting_transcript"]
}
```

```typescript
// handlers 키도 동일하게 언더스코어 사용
return {
  handlers: {
    "meeting_start": async (payload) => { /* ... */ },
    "meeting_stop":  async (payload) => { /* ... */ },
  },
};
```

### 두 네임스페이스 비교

| 구분 | 대상 | 도트 허용? | 예시 |
|------|------|-----------|------|
| 플러그인 ID | `id` 필드 | ✅ 허용 (도트 형식 권장) | `com.lge.meeting-recorder` |
| LLM tool name | `tools[]`, `handlers` 키 | ❌ 금지 | `meeting_start` |
| 이벤트 이름 | `emitEvent()` / `onEvent()` | ✅ 허용 | `meeting.summary.created` |
| keywords skillId | `keywords[].skillId` | ❌ 금지 (tool name과 일치) | `meeting_start` |

### 런타임 동작

**런타임 변환은 없습니다.** 매니페스트의 `tools[]` 값이 그대로 LLM tool name으로 등록됩니다. 도트가 포함된 도구 이름은 **로드 시 즉시 거부**됩니다.

```
// ✅ 올바른 구성
id: "com.lge.meeting-recorder"   ← 플러그인 ID, 도트 허용
tools: ["meeting_start"]          ← LLM tool name, 언더스코어 전용

// ❌ 잘못된 구성 (로드 거부됨)
tools: ["meeting.start"]          ← tool name에 도트 금지
```

---

## toolSchemas 작성 가이드

`toolSchemas`는 LLM이 각 도구를 정확하게 호출하도록 안내하는 JSON Schema 선언입니다.

### 왜 필요한가?

`toolSchemas`가 없으면 LLM은 도구의 입력 형식을 추측합니다. 올바른 스키마를 선언하면:
- LLM이 필수 인자를 누락 없이 전달함
- 타입 오류로 인한 도구 실패 감소
- 호스트 ToolRegistry가 입력 검증 가능

### 스키마 작성 규칙

1. `tools[]`에 선언된 모든 도구에 스키마를 작성하는 것을 권장합니다.
2. `inputSchema`는 JSON Schema Draft 7 형식을 따릅니다.
3. 필수 인자는 반드시 `required` 배열에 명시합니다.
4. `description`은 LLM이 도구를 선택하는 기준이 되므로 명확하게 작성합니다.

### 예제: 도구 스키마 작성

```json
{
  "toolSchemas": {
    "meeting_start": {
      "description": "새 회의 녹음 세션을 시작합니다. 세션 ID를 반드시 전달해야 합니다.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": {
            "type": "string",
            "description": "세션 고유 식별자 (예: 'sess-20260418-001')"
          }
        },
        "required": ["sessionId"],
        "additionalProperties": false
      }
    },
    "meeting_push_chunk": {
      "description": "녹음 중인 세션에 오디오 청크 데이터를 주입합니다.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": { "type": "string", "description": "대상 세션 ID" },
          "chunk": { "type": "string", "description": "base64 인코딩된 오디오 데이터" }
        },
        "required": ["sessionId", "chunk"],
        "additionalProperties": false
      }
    },
    "meeting_sessions": {
      "description": "저장된 회의 세션 목록을 반환합니다. 인자 없이 호출합니다.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    }
  }
}
```

### 핸들러와 스키마 일관성 유지

`toolSchemas`에서 `required`로 선언한 인자는 핸들러 내부에서 반드시 검증하세요:

```typescript
"meeting_start": async (payload?: unknown) => {
  const body = (payload ?? {}) as { sessionId?: string };
  // toolSchemas에서 required: ["sessionId"]이므로 방어 코드 필수
  if (!body.sessionId) throw new Error("sessionId is required");
  // ...
}
```

---

## IPC/RPC 경계

플러그인 저자가 반드시 숙지해야 할 통신 경계 규칙입니다.

### 원칙: 플러그인은 IPC/RPC를 직접 사용하지 않는다

플러그인 번들에서 Electron의 `ipcRenderer` / `ipcMain`을 **절대로 import하지 마세요**. 모든 통신은 정해진 경계를 통해 이루어집니다.

### 허용된 통신 경계

| 방향 | 방법 | 비고 |
|------|------|------|
| LLM → 플러그인 도구 | ToolRegistry 경유 (자동) | 플러그인 코드 불필요 |
| Renderer UI → 플러그인 도구 | `lvis:plugins:call(toolName, payload)` | 호스트 generic IPC 단 하나 |
| 플러그인 → 호스트 | `PluginHostApi` 직접 호출 | `context.hostApi.*` |
| 플러그인 → 플러그인 | `emitEvent` / `onEvent` | 직접 참조 금지 |

### UI 모듈에서의 도구 호출

Renderer에 마운트되는 UI 모듈(사이드바 컴포넌트)은 `hostApi.callTool()`을 통해 도구를 호출합니다. 이 `hostApi`는 플러그인 팩토리의 `context.hostApi`와 다른, UI 전용 인터페이스입니다.

```javascript
// ✅ 올바름 — UI 모듈에서 도구 호출
export default async function MyPluginUI({ container, hostApi }) {
  const result = await hostApi.callTool("meeting_start", { sessionId: "sess-001" });
}

// ❌ 금지 — 플러그인 번들에서 IPC 직접 사용
import { ipcRenderer } from "electron"; // 절대 금지
ipcRenderer.invoke("lvis:some:channel", ...); // 절대 금지
```

### 플러그인 간 통신

플러그인이 다른 플러그인의 기능을 트리거해야 할 때는 이벤트를 사용합니다:

```typescript
// ✅ 올바름 — 이벤트로 간접 통신
hostApi.emitEvent("calendar.event.created", { eventId: "evt-001" });

// ❌ 금지 — 다른 플러그인 핸들러 직접 import/참조
import { handleCalendarCreate } from "@lvis/plugin-calendar"; // 절대 금지
```

---

## UI 확장

플러그인은 사이드바 슬롯에 React/vanilla JS 컴포넌트를 마운트할 수 있습니다.

### UI 확장 타입

```typescript
interface PluginUiExtension {
  id: string;                    // 고유 ID (예: "meeting-control")
  slot: "sidebar";               // 마운트 슬롯 (현재는 sidebar만 지원)
  kind: "embedded-module" | "embedded-page" | "info-card";
  displayName?: string;          // 사이드바에 표시할 이름
  title: string;                 // UI 제목
  description?: string;          // UI 설명
  defaults?: Record<string, unknown>;  // 초기값
  entry?: string;                // JS 파일 경로
  exportName?: string;           // 내보낸 함수/클래스 이름
  page?: string;                 // 페이지 식별자
}
```

### 예제: 미팅 컨트롤 UI

```json
{
  "ui": [
    {
      "id": "meeting-control",
      "slot": "sidebar",
      "kind": "embedded-module",
      "displayName": "미팅",
      "title": "Meeting Recorder",
      "description": "회의 세션을 관리합니다.",
      "entry": "../../../node_modules/@lvis/plugin-meeting/dist/ui/meeting-control.js"
    }
  ]
}
```

### UI 모듈 작성 (Vanilla JS)

```javascript
// ui/meeting-control.js

/**
 * UI 모듈 (sidebar에 마운트될 컴포넌트)
 *
 * @param {Object} props
 * @param {HTMLElement} props.container - 마운트 대상 DOM 노드
 * @param {Object} props.hostApi - 호스트 도구 API
 *   - hostApi.callTool(toolName, payload): Promise
 *   - hostApi.onToolResult(listener): 도구 실행 결과 구독
 * @param {Object} props.config - 매니페스트 config
 * @returns {Object} UI 객체 (선택: { cleanup?: () => void })
 */
export default async function MeetingControlUI({ container, hostApi, config }) {
  // UI 초기화
  const html = `
    <div class="meeting-control">
      <button id="start-btn">회의 시작</button>
      <button id="stop-btn" disabled>회의 종료</button>
      <div id="status"></div>
    </div>
  `;
  container.innerHTML = html;

  const startBtn = container.querySelector("#start-btn");
  const stopBtn = container.querySelector("#stop-btn");
  const statusDiv = container.querySelector("#status");

  let sessionId = null;

  // 회의 시작
  startBtn.addEventListener("click", async () => {
    sessionId = `sess-${Date.now()}`;
    try {
      const result = await hostApi.callTool("meeting_start", {
        sessionId,
      });
      statusDiv.textContent = `회의 시작: ${result.sessionId}`;
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } catch (err) {
      statusDiv.textContent = `오류: ${err.message}`;
    }
  });

  // 회의 종료
  stopBtn.addEventListener("click", async () => {
    try {
      const result = await hostApi.callTool("meeting_stop", { sessionId });
      statusDiv.textContent = `요약: ${result.summary.slice(0, 50)}...`;
      startBtn.disabled = false;
      stopBtn.disabled = true;
    } catch (err) {
      statusDiv.textContent = `오류: ${err.message}`;
    }
  });

  // 정리 함수 (플러그인 제거 시 호출)
  return {
    cleanup: () => {
      container.innerHTML = "";
    },
  };
}
```

### UI 모듈 작성 (React)

```typescript
// ui/meeting-control.tsx
import React, { useState } from "react";

interface UIProps {
  container: HTMLElement;
  hostApi: {
    callTool(toolName: string, payload: unknown): Promise<unknown>;
    onToolResult(listener: (result: unknown) => void): void;
  };
  config: Record<string, unknown>;
}

export default async function MeetingControlUI({
  container,
  hostApi,
  config,
}: UIProps) {
  const root = ReactDOM.createRoot(container);

  function MeetingControl() {
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [status, setStatus] = useState("");
    const [isRecording, setIsRecording] = useState(false);

    const handleStart = async () => {
      const newSessionId = `sess-${Date.now()}`;
      try {
        const result = (await hostApi.callTool("meeting_start", {
          sessionId: newSessionId,
        })) as { sessionId: string };
        setSessionId(result.sessionId);
        setStatus("회의 시작됨");
        setIsRecording(true);
      } catch (err) {
        setStatus(`오류: ${(err as Error).message}`);
      }
    };

    const handleStop = async () => {
      if (!sessionId) return;
      try {
        const result = (await hostApi.callTool("meeting_stop", {
          sessionId,
        })) as { summary: string };
        setStatus(`요약: ${result.summary.slice(0, 50)}...`);
        setIsRecording(false);
      } catch (err) {
        setStatus(`오류: ${(err as Error).message}`);
      }
    };

    return (
      <div className="meeting-control p-4">
        <button
          onClick={handleStart}
          disabled={isRecording}
          className="btn btn-primary"
        >
          회의 시작
        </button>
        <button
          onClick={handleStop}
          disabled={!isRecording}
          className="btn btn-secondary ml-2"
        >
          회의 종료
        </button>
        <p className="mt-2 text-sm">{status}</p>
      </div>
    );
  }

  root.render(<MeetingControl />);

  return {
    cleanup: () => root.unmount(),
  };
}
```

---

## 빌드 설정

LVIS 플러그인은 TypeScript로 작성되고 `tsup` + `vitest`로 빌드·테스트됩니다.

### package.json

```json
{
  "name": "@lvis/plugin-example",
  "version": "1.0.0",
  "description": "LVIS 플러그인 예제",
  "type": "module",
  "main": "dist/index.cjs",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./host-plugin": {
      "types": "./dist/hostPlugin.d.ts",
      "import": "./dist/hostPlugin.js",
      "require": "./dist/hostPlugin.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup && mkdir -p dist/ui && cp src/ui/*.html dist/ui/ && cp src/ui/*.js dist/ui/",
    "clean": "rm -rf dist coverage",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev:test": "vitest"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsup": "^8.2.4",
    "typescript": "^5.8.3",
    "vitest": "^4.1.4"
  },
  "dependencies": {
    "@lvis/plugin-types": "workspace:*"
  }
}
```

### tsup.config.ts

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/hostPlugin.ts"],
  format: ["esm", "cjs"],  // CommonJS와 ES Module 모두 생성
  dts: true,               // TypeScript 타입 파일 생성
  sourcemap: true,         // 소스맵 생성
  clean: true,             // 빌드 전 dist/ 정리
  target: "node18",        // Node 18 이상 대상
  outDir: "dist",
  splitting: false,        // 파일 분할 금지 (plugin.json entry가 정확해야 함)
});
```

**주의**: `splitting: false`는 필수입니다. 플러그인 매니페스트의 `entry` 경로가 정확해야 합니다.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020"],
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

---

## 테스팅

### vitest.config.ts

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
```

### 테스트 작성 예제

```typescript
// test/hostPlugin.test.ts
import { describe, it, expect, vi } from "vitest";
import createPlugin from "../src/hostPlugin.js";

describe("Meeting Plugin", () => {
  it("should register keywords on startup", async () => {
    const mockRegisterKeywords = vi.fn();
    const mockHostApi = {
      registerKeywords: mockRegisterKeywords,
      emitEvent: vi.fn(),
      onEvent: vi.fn(),
      addTask: vi.fn(),
      saveNote: vi.fn(),
      getSecret: vi.fn(() => null),
      getMsGraphToken: vi.fn(async () => null),
      startMsGraphAuth: vi.fn(async () => {}),
      isMsGraphAuthenticated: vi.fn(() => false),
      getMsGraphAccount: vi.fn(() => null),
      onMsGraphAuthChange: vi.fn(),
    };

    const plugin = await createPlugin({
      pluginId: "meeting",
      pluginRoot: "/plugin/root",
      hostRoot: "/host/root",
      log: vi.fn(),
      hostApi: mockHostApi,
    });

    // 키워드 등록 확인
    expect(mockRegisterKeywords).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ keyword: "회의록", skillId: "meeting_start" }),
      ])
    );

    // 도구 핸들러 존재 확인
    expect(plugin.handlers["meeting_start"]).toBeDefined();
  });

  it("should handle meeting_start correctly", async () => {
    const mockEmitEvent = vi.fn();
    const mockHostApi = {
      registerKeywords: vi.fn(),
      emitEvent: mockEmitEvent,
      onEvent: vi.fn(),
      addTask: vi.fn(),
      saveNote: vi.fn(),
      getSecret: vi.fn(() => null),
      getMsGraphToken: vi.fn(async () => null),
      startMsGraphAuth: vi.fn(async () => {}),
      isMsGraphAuthenticated: vi.fn(() => false),
      getMsGraphAccount: vi.fn(() => null),
      onMsGraphAuthChange: vi.fn(),
    };

    const plugin = await createPlugin({
      pluginId: "meeting",
      pluginRoot: "/plugin/root",
      hostRoot: "/host/root",
      log: vi.fn(),
      hostApi: mockHostApi,
    });

    const result = await plugin.handlers["meeting_start"]({
      sessionId: "test-session",
    });

    expect(result).toEqual({
      sessionId: "test-session",
      started: true,
    });
    expect(mockEmitEvent).toHaveBeenCalledWith("meeting.started", {
      sessionId: "test-session",
    });
  });
});
```

### 빌드 및 테스트 실행

```bash
# 플러그인 빌드
npm run build

# 타입 체크
npm run typecheck

# 테스트 실행 (한 번)
npm test

# 개발 모드 테스트 (watch)
npm run dev:test
```

---

## 설치 및 배포

### 플러그인 디렉토리 구조

```
lvis-app/
  plugins/
    installed/
      {plugin-id}/
        plugin.json          ← 매니페스트
        ... (플러그인 파일)
```

### 예제: Meeting 플러그인 설치

```
lvis-app/plugins/installed/meeting/
  plugin.json
  dist/
    hostPlugin.js
    hostPlugin.d.ts
    index.js
    index.d.ts
    ui/
      meeting-control.js
      meeting-control.html
```

### registry.json

호스트 앱은 `plugins/registry.json`에서 설치된 플러그인 목록을 관리합니다.

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "meeting",
      "manifestPath": "plugins/installed/meeting/plugin.json",
      "enabled": true
    },
    {
      "id": "email",
      "manifestPath": "plugins/installed/email/plugin.json",
      "enabled": true
    },
    {
      "id": "pageindex",
      "manifestPath": "plugins/installed/pageindex/plugin.json",
      "enabled": true
    }
  ]
}
```

### 플러그인 발견 및 로드 (boot.ts)

호스트 `boot.ts`는 시작 시 `registry.json`을 읽고 모든 활성화된 플러그인을 로드합니다.

```typescript
// boot.ts (§4.2 Boot Sequence)
async function loadPlugins(app: App) {
  const registryPath = join(app.getPath("userData"), "plugins", "registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf-8"));

  for (const entry of registry.plugins) {
    if (!entry.enabled) continue;

    const manifest = JSON.parse(
      await fs.readFile(entry.manifestPath, "utf-8")
    );

    const pluginRoot = dirname(entry.manifestPath);
    const entryPath = resolve(pluginRoot, manifest.entry);

    // hostPlugin.js import
    const createPlugin = (await import(entryPath)).default;

    // 플러그인 실행
    const plugin = await createPlugin({
      pluginId: manifest.id,
      pluginRoot,
      hostRoot: app.getPath("userData"),
      config: manifest.config ?? {},
      log: (msg, meta) => console.log(`[${manifest.id}] ${msg}`, meta),
      hostApi: createHostApi(manifest.id),
    });

    // 도구 핸들러 등록
    for (const [toolName, handler] of Object.entries(plugin.handlers ?? {})) {
      toolRegistry.register(manifest.id, toolName, handler);
    }
  }
}
```

### 플러그인 제거

플러그인 제거 시:

1. `registry.json`에서 플러그인 항목 삭제 또는 `enabled: false` 설정
2. 호스트 재시작
3. 플러그인의 `stop()` 함수 호출 (있는 경우)
4. 플러그인이 등록한 모든 것(키워드, 이벤트 핸들러 등) 자동 정리

---

## 완전한 예제

### 이메일 플러그인 (간단한 예제)

```typescript
// src/hostPlugin.ts
import type { PluginToolHandler } from "@lvis/plugin-types";
import { GraphClient } from "./graphClient.js";
import { analyzeEmailWithAI } from "./emailAnalyzer.js";

type HostPluginContext = {
  pluginId: string;
  pluginRoot: string;
  hostRoot: string;
  config?: Record<string, unknown>;
  log: (message: string, meta?: unknown) => void;
  hostApi: {
    registerKeywords(keywords: Array<{ keyword: string; skillId: string }>): void;
    emitEvent(type: string, data?: unknown): void;
    onEvent(type: string, handler: (data: unknown) => void): void;
    addTask(task: {
      title: string;
      description?: string;
      source: string;
      sourceRef?: string;
      priority?: string;
    }): void;
    saveNote(title: string, content: string): void;
    getSecret(key: string): string | null;
    getMsGraphToken(): Promise<string | null>;
    startMsGraphAuth(): Promise<void>;
    isMsGraphAuthenticated(): boolean;
    getMsGraphAccount(): { name?: string; email?: string } | null;
    onMsGraphAuthChange(handler: (authenticated: boolean) => void): void;
  };
};

export default async function createPlugin(context: HostPluginContext) {
  const { hostApi } = context;

  // Microsoft Graph 클라이언트 초기화
  const client = new GraphClient(context.hostRoot);

  // API 키 조회
  const apiKey =
    (context.config?.openaiApiKey as string) ||
    hostApi.getSecret("llm.apiKey.openai") ||
    undefined;

  // ──── 자기 등록: 키워드 ────
  hostApi.registerKeywords([
    { keyword: "이메일", skillId: "email_list" },
    { keyword: "메일", skillId: "email_list" },
    { keyword: "email", skillId: "email_list" },
  ]);

  // MS Graph 인증 상태 변경 감지
  hostApi.onMsGraphAuthChange((authenticated) => {
    context.log(`MS Graph auth: ${authenticated}`);
  });

  return {
    handlers: {
      "email_login": async () => {
        await hostApi.startMsGraphAuth();
        return {
          authenticated: hostApi.isMsGraphAuthenticated(),
          account: hostApi.getMsGraphAccount(),
        };
      },

      "email_status": async () => ({
        authenticated: hostApi.isMsGraphAuthenticated(),
        account: hostApi.getMsGraphAccount() ?? undefined,
      }),

      "email_list": async (payload?: unknown) => {
        const token = await hostApi.getMsGraphToken();
        if (!token) throw new Error("먼저 로그인해주세요 (email_login)");
        const p = (payload ?? {}) as { top?: number };
        return client.listEmails(token, p.top ?? 20);
      },

      "email_read": async (payload?: unknown) => {
        const token = await hostApi.getMsGraphToken();
        if (!token) throw new Error("먼저 로그인해주세요 (email_login)");
        const p = (payload ?? {}) as { id?: string };
        if (!p.id) throw new Error("id가 필요합니다");
        return client.readEmail(token, p.id);
      },

      "email_analyze": async (payload?: unknown) => {
        const token = await hostApi.getMsGraphToken();
        if (!token) throw new Error("먼저 로그인해주세요 (email_login)");
        const p = (payload ?? {}) as { id?: string };
        if (!p.id) throw new Error("id가 필요합니다");

        const email = await client.readEmail(token, p.id);
        const analysis = apiKey
          ? await analyzeEmailWithAI(email, apiKey)
          : { actionRequired: false, tasks: [] };

        if (analysis.actionRequired) {
          hostApi.emitEvent("email.action_needed", {
            emailId: p.id,
            subject: email.subject,
            taskCount: analysis.tasks?.length ?? 0,
          });
        }

        for (const task of analysis.tasks ?? []) {
          hostApi.addTask({
            title: task.title.slice(0, 100),
            description: `이메일(${email.subject})에서 추출된 할 일`,
            source: "email",
            sourceRef: p.id,
            priority: task.priority ?? "medium",
          });
        }

        return { email, analysis, isAI: !!apiKey };
      },
    } satisfies Record<string, PluginToolHandler>,
  };
}
```

### plugin.json

```json
{
  "id": "email",
  "name": "LVIS Email",
  "version": "1.0.0",
  "entry": "../../../node_modules/@lvis/plugin-email/dist/hostPlugin.js",
  "tools": ["email_login", "email_status", "email_list", "email_read", "email_analyze"],
  "toolSchemas": {
    "email_login": {
      "description": "Microsoft 365 계정으로 로그인합니다. 이메일 조회 전 반드시 호출해야 합니다.",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    },
    "email_list": {
      "description": "수신함의 최근 이메일 목록을 반환합니다.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "top": { "type": "number", "description": "최대 조회 건수 (기본: 20)" }
        },
        "additionalProperties": false
      }
    },
    "email_read": {
      "description": "특정 이메일의 본문을 조회합니다.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": { "type": "string", "description": "이메일 ID" }
        },
        "required": ["id"],
        "additionalProperties": false
      }
    }
  },
  "config": {
    "openaiApiKey": ""
  },
  "ui": [
    {
      "id": "email-control",
      "slot": "sidebar",
      "kind": "embedded-module",
      "displayName": "이메일",
      "title": "Email Manager",
      "description": "이메일 계정을 연결하고 메시지를 조회합니다.",
      "entry": "../../../node_modules/@lvis/plugin-email/dist/ui/email-control.js"
    }
  ]
}
```

---

## 체크리스트

새 플러그인 개발 시 이 체크리스트를 따르세요.

- [ ] **프로젝트 설정**
  - [ ] `package.json` (name, exports, scripts)
  - [ ] `tsup.config.ts` (entry, format, dts)
  - [ ] `tsconfig.json` (strict mode)
  - [ ] `vitest.config.ts`

- [ ] **플러그인 매니페스트**
  - [ ] `plugin.json` 생성
  - [ ] `id`, `name`, `version` 설정
  - [ ] `entry` 경로 (hostPlugin.js)
  - [ ] `tools` 배열 (언더스코어 형식)
  - [ ] `toolSchemas` 작성 (LLM function calling 정확도 향상)
  - [ ] `config` 기본값 (있는 경우)
  - [ ] `ui` 확장 (있는 경우)

- [ ] **hostPlugin.ts 구현**
  - [ ] `createPlugin` 함수 내보내기 (`PluginToolHandler` 타입 사용)
  - [ ] `hostApi.registerKeywords()` 호출
  - [ ] 이벤트 발행 (`hostApi.emitEvent()`)
  - [ ] 도구 핸들러 구현 (`handlers` 객체)
  - [ ] 오류 처리 (throw 명시적)
  - [ ] 로깅 (`context.log()`)
  - [ ] Electron IPC 직접 사용 금지 (`ipcRenderer` / `ipcMain` import 금지)

- [ ] **테스팅**
  - [ ] 단위 테스트 작성 (`test/*.test.ts`)
  - [ ] `npm test` 통과
  - [ ] 타입 체크 (`npm run typecheck`)

- [ ] **UI (선택)**
  - [ ] UI 모듈 작성 (`src/ui/*.js`)
  - [ ] `plugin.json`의 `ui` 섹션 설정
  - [ ] 빌드 스크립트에서 UI 파일 복사
  - [ ] UI에서 도구 호출 시 `hostApi.callTool()` 사용 (IPC 직접 사용 금지)

- [ ] **빌드 및 배포**
  - [ ] `npm run build` 성공
  - [ ] `dist/hostPlugin.js` 생성 확인
  - [ ] `plugins/installed/{id}/` 디렉토리 생성
  - [ ] `plugin.json` 복사
  - [ ] `registry.json`에 항목 추가
  - [ ] 호스트 재시작 후 플러그인 로드 확인

---

## 향후 계획 (미구현)

이 섹션은 아직 구현되지 않은 기능을 기록합니다. 본문 예제에서 이 기능들을 사용하지 마세요.

### Phase 2 예정

| 기능 | 설명 |
|------|------|
| `startupTimeoutMs` | startupTools 실행 시 타임아웃 (매니페스트 필드) |
| `logEvent()` | HostApi 로그 이벤트 기록 메서드 |
| `onShutdown()` | HostApi 앱 종료 훅 등록 메서드 |

### Phase 3 예정

| 기능 | 설명 |
|------|------|
| `signature` / `signatureAlgorithm` | 플러그인 코드 서명 검증 (매니페스트 필드) |
| 플러그인 마켓플레이스 | 원격 플러그인 검색 및 설치 UI |

---

## 참고 자료

- [아키텍처 문서 §9 — Plugin System & UI Extension](../architecture/architecture.md#9-plugin-system--ui-extension)
- [CLAUDE.md](../../CLAUDE.md)
- Meeting 플러그인 (실제 예제) — 별도 플러그인 저장소(`lvis-project/lvis-plugin-meeting`) 또는 외부 문서를 참조하세요.
- Email 플러그인 (실제 예제) — 별도 플러그인 저장소(`lvis-project/lvis-plugin-email`) 또는 외부 문서를 참조하세요.
