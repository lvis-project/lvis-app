# Plugin Schema Design — LVIS

**Status:** v3 고도화  
**Updated:** 2026-04-18  
**Architect 승인:** Top 3 권고 반영 (toolSchemas / startup timeout / @lvis/plugin-sdk)

---

## 1. 설계 원칙

플러그인은 `HostApi`를 통해 자기 자신을 등록한다. 호스트 앱은 플러그인별 코드를 포함하지 않는다.

**핵심 원칙:**

1. **Capability gate = HostApi** — 권한 선언 없이 API 자체가 허용 범위를 규정한다.
2. **implement-first, declare-incrementally** — 메서드를 먼저 구현하고, LLM 파라미터 추론이 불충분할 때 `toolSchemas`를 추가한다. 빈 스키마 선언은 의미 없다.
3. **In-process + try/catch** — worker_threads 격리 없이 95% 장애를 커버. 런타임 복잡도를 낮게 유지.
4. **플러그인 저자가 스키마 수기 작성** — zod 자동추출 금지. 번들 크기·버전 충돌 없음.
5. **JSON Schema draft-07 + `type: "object"` 필수** — OpenAI/Claude/Gemini 모두 top-level object 요구.
6. **Runtime 검증은 플러그인이 선택** — 호스트는 스키마를 LLM에 전달할 뿐, ajv/zod는 플러그인 재량.

---

## 2. PluginManifest 필드별 스펙

```typescript
interface PluginManifest {
  /** 플러그인 고유 식별자. dot 형식: "com.lge.meeting-recorder" */
  id: string;
  name: string;
  version: string;
  /** 플러그인 진입점 JS 파일 경로 (플러그인 루트 기준) */
  entry: string;
  /**
   * LLM에 노출되는 tool name 목록. underscore 형식만 허용.
   * ^[a-zA-Z_][a-zA-Z0-9_]*$ — 도트·하이픈 금지.
   * runtime.ts가 이 배열 그대로 Tool Registry에 등록.
   */
  methods: string[];
  /**
   * [Phase 1 신규] 메서드별 JSON Schema (선택적).
   * 없으면 기존 generic { payload: object } fallback 유지.
   * LLM 파라미터 추론이 불충분하다고 판단될 때만 추가.
   */
  toolSchemas?: Record<string, {
    description?: string;
    /** JSON Schema draft-07. type: "object" 필수. */
    inputSchema: Record<string, unknown>;
  }>;
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  keywords?: Array<{ keyword: string; skillId: string }>;
  capabilities?: string[];
  startupMethods?: string[];
  eventSubscriptions?: string[];
  ipcBindings?: PluginIpcBinding[];
  deployment?: "managed" | "user";
  publisher?: string;
  /**
   * [Phase 2 신규] 시작 제한 시간 (ms). 선언 시 boot에서 해당 시간 초과 시 강제 중단.
   * 미선언 시 기본 동작: Promise.allSettled 병렬 + 5s warn 로깅.
   */
  startupTimeoutMs?: number;
  /** Python 런타임이 필요한 플러그인 전용. */
  python?: {
    managedBy: "lvis-app";
    requirementsLock: string;
  };
}
```

**각 필드의 런타임 소비처:**

| 필드 | 소비처 | 타이밍 |
|------|--------|--------|
| `id` | PluginRegistry, HostApi cleanup | boot + 런타임 전반 |
| `entry` | runtime.ts `require()` | boot |
| `methods[]` | Tool Registry 등록 | boot |
| `toolSchemas` | LLM system prompt에 tool schema로 삽입 | system prompt 빌드 시 |
| `keywords[]` | KeywordEngine 등록 | boot |
| `ui[]` | plugin-ui-host.tsx 마운트 | boot + UI 렌더 |
| `startupMethods[]` | boot 시 자동 호출 (init 류) | boot |
| `eventSubscriptions[]` | ProactiveEngine 연동 참고 | boot |
| `startupTimeoutMs` | runtime.ts 병렬 로딩 시 AbortController | boot |
| `deployment` | DeploymentGuard | install + uninstall |

**plugin.json 전체 예시 (meeting 플러그인):**

```json
{
  "id": "com.lge.meeting-recorder",
  "name": "회의록 녹음",
  "version": "1.3.0",
  "entry": "dist/index.js",
  "methods": [
    "meeting_start",
    "meeting_push_chunk",
    "meeting_stop",
    "meeting_transcript",
    "meeting_sessions"
  ],
  "toolSchemas": {
    "meeting_start": {
      "description": "회의 녹음 세션 시작",
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
  "deployment": "managed",
  "publisher": "LG Electronics DX Platform Team"
}
```

---

## 3. toolSchemas 작성 가이드

`toolSchemas`는 LLM이 파라미터를 잘못 추론하는 메서드에만 추가한다.  
top-level은 반드시 `"type": "object"` — 모든 LLM vendor 공통 요구사항.

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

### 예시 2: calendar_create (nested required + attendees 배열)

```json
{
  "calendar_create": {
    "description": "Microsoft Graph를 통해 캘린더 일정 생성",
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

### 예시 3: email_reply (사전 조건 명시)

```json
{
  "email_reply": {
    "description": "지정 이메일에 답장. email_list 또는 email_read로 id를 먼저 획득해야 함.",
    "inputSchema": {
      "type": "object",
      "required": ["id", "body"],
      "properties": {
        "id": { "type": "string", "description": "email_list 응답의 id 필드" },
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
| `emitEvent(name, payload)` | 다른 플러그인·ProactiveEngine에 이벤트 발행 | 직접 플러그인 간 함수 호출 대체용 |
| `onEvent(name, handler)` | 다른 플러그인 이벤트 구독 | 폴링 대체 (push 모델이므로 충분) |
| `addTask(task)` | 액션 아이템 → LVIS 태스크 자동 생성 | UI 직접 조작 대체 |
| `saveNote(title, content)` | `~/.lvis/notes/`에 회의록·요약 저장 | 대용량 바이너리 저장 |
| `getSecret(key)` | 암호화된 API 키 조회 | 키를 메모리에 캐시 후 재사용 (매번 호출) |
| `getMsGraphToken()` | Office 365 API 호출 전 토큰 획득 | email/calendar 외 플러그인 |
| `startMsGraphAuth(openBrowser)` | 사용자 브라우저 OAuth 플로우 개시 | 자동화 컨텍스트 |
| `isMsGraphAuthenticated()` | handler 진입부에서 인증 상태 확인 | — |
| `getMsGraphAccount()` | 현재 로그인 계정 이메일 조회 | — |
| `onMsGraphAuthChange(handler)` | 인증 상태 변화 감지 (logout 처리 등) | — |
| `logEvent(level, message, data?)` | **[Phase 2 신규]** 호스트 감사 로그에 플러그인 이벤트 기록 | 디버그 전용 고빈도 로깅 (성능) |
| `onShutdown(handler)` | **[Phase 2 신규]** 앱 종료 전 정리 작업 (DB flush, 파일 저장 등) | 긴 비동기 작업 (5s 제한 있음) |

### logEvent 상세

```typescript
// 플러그인에서 사용
hostApi.logEvent("info", "meeting.ended", { sessionId, duration: 3600 });
hostApi.logEvent("warn", "stt.retry", { attempt: 2, error: "rate_limit" });
hostApi.logEvent("error", "summary.failed", { sessionId, error: e.message });
```

- 호스트 `audit-logger.ts`로 라우팅. DLP 필터 통과.
- `data` 필드는 직렬화 가능한 값만 허용 (Buffer, class instance 금지).
- `console.log` 대신 사용하면 중앙 감사 로그에 남는다.

### onShutdown 상세

```typescript
// 플러그인 초기화 시 등록
hostApi.onShutdown(async () => {
  await sessionStore.flushAll();
  watcher.stop();
});
```

- Electron `before-quit` 이벤트 체인에서 호출.
- `Promise.allSettled`로 모든 플러그인 shutdown 병렬 실행.
- 5초 초과 시 강제 종료 (로그 기록 후).
- 등록 순서와 실행 순서는 무관.

---

## 5. 번들 플러그인 케이스스터디

### 5.1 Meeting Recorder (`com.lge.meeting-recorder`)

**파일:** `lvis-plugin-meeting/src/hostPlugin.ts:128-200`

**주요 handler 시그니처:**

```typescript
meeting_start: async (payload?: unknown) => {
  const body = (payload ?? {}) as { sessionId?: string; context?: MeetingContext };
  if (!body.sessionId) throw new Error("sessionId is required");
  recorder.start(body.sessionId, body.context);
  hostApi.emitEvent("meeting.started", { sessionId: body.sessionId });
  return { sessionId: body.sessionId, started: true };
},

meeting_push_chunk: async (payload?: unknown) => {
  const body = (payload ?? {}) as { sessionId?: string; chunk?: MeetingChunk };
  if (!body.sessionId || !body.chunk) throw new Error("sessionId and chunk are required");
  // number[] → PCM16LE Buffer 변환 (Buffer.from()으로 하면 데이터 손상)
  const samples = body.chunk.pcm16leMono;
  const pcmBuffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcmBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0))), i * 2);
  }
  await recorder.pushAudioChunk(body.sessionId, { pcm16leMono: pcmBuffer, ... });
  return { sessionId: body.sessionId, added: transcript.length };
},

meeting_stop: async (payload?: unknown) => {
  // ... recorder.stop() 후 actionItems → hostApi.addTask() 자동 생성
  return final; // MeetingSummary 전체 반환
},
```

**toolSchemas 권고:** `meeting_push_chunk`만 추가. `meeting_start`는 LLM이 `sessionId: string` 충분히 추론 가능.

**교훈:**
- IPC 경계를 넘는 PCM 데이터는 `number[]`로 직렬화됨 — schema에서 `items.type: "integer"` 명시 필요.
- `meeting_stop` 반환값이 크므로 LLM context 소비 주의. 요약만 반환하도록 설계됨.
- `meeting_sessions` (인수 없음)는 schema 불필요.

---

### 5.2 PageIndex (`lvis-plugin-pageindex`)

**파일:** `lvis-plugin-pageindex/src/hostPlugin.ts:210-303`

**주요 handler 시그니처:**

```typescript
index_scan: async () => {
  await ensureStarted();
  const res = await autoIndexer.scanOnce();
  return {
    ...res,
    message: `스캔 완료. 현재 총 ${res.totalIndexed}개의 파일이 인덱싱되어 있으며...`,
  };
},

index_add_folder: async (payload?: unknown) => {
  const p = (payload ?? {}) as { folder?: string };
  if (!p.folder) throw new Error("folder 경로가 필요합니다.");
  const absPath = resolve(p.folder);
  // 보안: /etc, /usr, ~/.ssh 등 위험 경로 차단 (플랫폼별 prefix 매칭)
  if (isBlocked) throw new Error(`보안: '${absPath}' 경로는 인덱싱 대상으로 추가할 수 없습니다.`);
  // 중복 추가 방어 후 persistFolders() + rebuildIndexer()
  hostApi.emitEvent("index.folders.changed", { folders });
  return { folders, added: true, message: `폴더 추가: ${absPath}` };
},

chat_preview: async (payload?: unknown) => { ... },
```

**toolSchemas 권고:** `index_add_folder`에 추가.

```json
{
  "index_add_folder": {
    "description": "지정 로컬 폴더를 인덱싱 대상에 추가. 절대 경로 또는 ~/로 시작하는 경로 허용.",
    "inputSchema": {
      "type": "object",
      "required": ["folder"],
      "properties": {
        "folder": {
          "type": "string",
          "description": "인덱싱할 폴더 경로. 예: /Users/ken/Documents 또는 ~/Documents"
        }
      }
    }
  }
}
```

**교훈:**
- Python subprocess (30s 폴링)로 FileWatcher 대신 운영 중 — `index_scan` 호출 빈도가 높아도 무방하도록 멱등 설계.
- 폴더 경로 보안 차단 로직이 handler 내부에 있음 — HostApi 레벨 제어 없음. 이것이 "플러그인이 스스로 방어" 패턴의 실례.
- `index_documents`, `index_folders`는 인수 없음 — schema 불필요.

---

### 5.3 Email (`lvis-plugin-email`)

**파일:** `lvis-plugin-email/src/hostPlugin.ts:90-191`

**주요 handler 시그니처:**

```typescript
email_list: async (payload?: unknown) => {
  const p = (payload ?? {}) as { top?: number };
  return client.listEmails(p.top ?? 20);
},

email_reply: async (payload?: unknown) => {
  const p = (payload ?? {}) as { id?: string; body?: string; subject?: string; to?: string };
  if (!p.id || !p.body) throw new Error("id와 body가 필요합니다.");
  await client.replyToEmail(p.id, p.body);
  await persistReplies();
  return { sent: true };
},

email_create_event: async (payload?: unknown) => {
  const p = (payload ?? {}) as {
    title?: string; start?: string; end?: string;
    body?: string; location?: string;
  };
  if (!p.title || !p.start || !p.end) throw new Error("title, start, end가 필요합니다.");
  return client.createCalendarEvent({ ... });
},

email_analyze: async (payload?: unknown) => {
  // LLM으로 이메일 분석 → action required 시 hostApi.emitEvent("email.action.needed", ...)
},

email_start_watcher: async (payload?: unknown) => {
  const p = (payload ?? {}) as { intervalMs?: number };
  watcher.start(p.intervalMs ?? 30_000);
  return { started: true, running: watcher.isRunning() };
},
```

**toolSchemas 권고:** `email_reply`, `email_create_event`에 추가.

**교훈:**
- MS Graph OAuth 상태 확인이 모든 인증 필요 handler 진입부에 중복 — `if (!hostApi.isMsGraphAuthenticated()) throw` 패턴.
- `email_analyze`는 내부적으로 LLM API 호출 (plugin이 직접 OpenAI 호출) — HostApi LLM 추상화 없음이 의도된 설계.
- `email_start_watcher` / `email_stop_watcher` 쌍은 LLM이 직접 호출하기보다 `startupMethods`나 UI에서 호출하는 것이 자연스럽다.

---

### 5.4 Calendar (`lvis-plugin-calendar`)

**파일:** `lvis-plugin-calendar/src/hostPlugin.ts:92-188`

**주요 handler 시그니처:**

```typescript
calendar_list: async (payload?: unknown) => {
  const p = (payload ?? {}) as { days?: number; top?: number };
  return client.listEvents({ days: p.days ?? 7, top: p.top ?? 50 });
},

calendar_create: async (payload?: unknown) => {
  const p = (payload ?? {}) as {
    title?: string; start?: string; end?: string;
    body?: string; location?: string; timeZone?: string; attendees?: string[];
  };
  if (!p.title || !p.start || !p.end) throw new Error("title, start, end가 필요합니다.");
  const event = await client.createEvent({ ... });
  log(`[calendar] 일정 생성: ${event.subject} (${event.start})`);
  return event;
},

calendar_update: async (payload?: unknown) => {
  const p = (payload ?? {}) as {
    id?: string; title?: string; start?: string; end?: string;
    body?: string; location?: string; timeZone?: string;
  };
  if (!p.id) throw new Error("id가 필요합니다.");
  return client.updateEvent(p.id, { ... });
},

calendar_open_url: async (payload?: unknown) => {
  // URL scheme 검증: https만 허용, 파싱 실패 시 throw
},
```

**toolSchemas 권고:** `calendar_create`, `calendar_update`에 추가.

**교훈:**
- `calendar_create`의 `attendees?: string[]`는 LLM이 단일 문자열로 전달하는 경우가 있음 — schema에 `type: "array"` 명시 필요.
- `timeZone`은 자유 문자열이지만 `description: "IANA 시간대. 예: Asia/Seoul"`로 가이드.
- `calendar_open_url`은 보안 handler: URL scheme 검증을 플러그인이 직접 수행. HostApi에 URL 검증 위임 안 함.

---

## 6. HostApi 확장 가이드

### 6.1 새 메서드 추가 조건 — "3+ 플러그인 규칙"

HostApi에 새 메서드를 추가하려면:

1. **3개 이상의 플러그인이 동일 기능을 필요로 해야** — 1~2개는 플러그인이 직접 구현.
2. 보안·감사 통제가 필요한 경우 (예: 파일 쓰기, 외부 네트워크) — 1개 플러그인도 가능.
3. host 앱이 이미 가진 서비스를 노출하는 경우 (예: MS Graph 토큰).

### 6.2 추가 절차

1. `src/plugins/types.ts`의 `PluginHostApi` 인터페이스에 메서드 추가
2. `src/plugins/runtime.ts`의 HostApi 구현체에 실제 구현
3. `docs/references/plugin-tool-schema-design.md` §4 표 업데이트
4. `docs/architecture/architecture.md` §9.4 HostApi 표 업데이트
5. 변경 커밋 — 플러그인 저자에게 공지 (semver minor bump)

### 6.3 명시적 기각 목록

아래 설계는 아키텍트 검토에서 **과잉설계**로 기각되었다. Future work로 남기지 않는다.

| 제안 | 기각 사유 |
|------|-----------|
| **worker_threads / process 격리** | in-process + try/catch로 95% 장애 커버. 격리 시 IPC 오버헤드 + 디버깅 복잡도 증가. 실제 장애 패턴이 요구할 때 재논의. |
| **manifest signature 검증 재도입** | 배포 파이프라인(CI/CD, managed installer)이 무결성을 보장. 런타임 재검증은 이중화. |
| **`permissions[]` 선언형 필드** | HostApi 자체가 capability gate. 선언만 하고 강제하지 않으면 거짓 보안감. |
| **LLM invoke HostApi 추상화** | vendor별 streaming·thinking·tool_choice 편차가 커서 단일 추상화 불가. 플러그인이 직접 SDK 사용. |
| **파일 watcher HostApi (`watchFiles`)** | pageindex 1개 플러그인만 필요. "3+ 플러그인 규칙" 미충족. 플러그인이 chokidar 직접 사용. |
| **zod 자동 schema 추출** | 번들 크기 증가, zod 버전 충돌 위험. 수기 작성이 LLM 최적화 면에서도 우수. |
| **`toolSchemas` output schema (Phase 1)** | 응답은 LLM이 string으로 재소비 가능. 추가 이득 없음. Phase 2에서 필요 시 재검토. |
| **Full capability grant system** | HostApi boundary가 capability를 규정. 별도 grant 레이어는 over-engineering. |
| **Hot reload (Phase 1)** | 개발 편의 기능. GA 블로커 아님. 안정화 후 재논의. |

---

## 7. Tool 명명 / Deployment

### 명명 규칙

- **LLM tool name**: `^[a-zA-Z_][a-zA-Z0-9_]*$` — underscore 형식. `methods[]`에 직접 선언.
- **플러그인 ID**: dot 형식 (`com.lge.meeting-recorder`). LLM에 노출 안 됨.
- **이벤트 채널**: dot 형식 (`meeting.started`, `email.action.needed`). 별도 네임스페이스.
- 런타임 변환 없음 — manifest에 선언한 이름이 그대로 Tool Registry에 등록됨.

### Deployment 모드

| 항목 | `managed` | `user` |
|------|-----------|--------|
| 설치 주체 | 회사 IT Admin | 사용자 직접 |
| 삭제 권한 | 회사만 (`PluginDeploymentGuard.canUninstall()` = false) | 사용자 자유 |
| 업데이트 | 정책 push 시 강제 | 사용자 opt-in |
| 저장 경로 | `~/.lvis/plugins/managed/<id>/<version>/` | `~/.lvis/plugins/user/<id>/` |
| 서명 검증 | LG Internal Root CA 필수 | 정책 설정에 따라 |

상세 설계: `docs/architecture/plugin-deployment-model.md`

### 현행 코드 참조

| 역할 | 파일 |
|------|------|
| `PluginManifest` 타입 | `src/plugins/types.ts` |
| `PluginHostApi` 인터페이스 | `src/plugins/types.ts` |
| 플러그인 런타임 (로딩·주입) | `src/plugins/runtime.ts` |
| Deployment 가드 | `src/plugins/deployment-guard.ts` |
| 등록 진입점 | `src/boot.ts` |
| 번들 플러그인 빌드 | `package.json` `prepare:plugins` 스크립트 |

---

## 8. 플러그인 저자 Quick-Start

### 스캐폴딩

```
my-plugin/
  plugin.json          ← manifest (id, name, version, entry, methods)
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
// 현재 경로: import type { RuntimePluginFactory } from "../../lvis-app/src/plugins/types";

export const createPlugin: RuntimePluginFactory = async (context) => {
  const { hostApi, config, log } = context;

  // 1. 키워드 등록 (선택)
  hostApi.registerKeywords([{ keyword: "내키워드", skillId: "my-skill" }]);

  // 2. 종료 핸들러 등록 (선택, Phase 2 이후)
  // hostApi.onShutdown(async () => { ... });

  return {
    // 3. 시작 훅 (선택)
    start: async () => {
      log("플러그인 시작");
    },

    // 4. 메서드 구현 — methods[]에 선언한 이름과 1:1 매칭
    handlers: {
      my_action: async (payload?: unknown) => {
        const p = (payload ?? {}) as { input?: string };
        if (!p.input) throw new Error("input이 필요합니다.");
        // 로직 구현
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
  "entry": "dist/index.js",
  "methods": ["my_action"],
  "deployment": "user"
}
```

### 첫 메서드까지 체크리스트

- [ ] `methods[]` 이름과 `handlers` 키가 정확히 일치하는지 확인
- [ ] 모든 handler가 `payload?: unknown`을 타입 캐스팅 후 사용하는지 확인
- [ ] 필수 파라미터 누락 시 `throw new Error()`로 명확한 에러 메시지
- [ ] `dist/index.js`가 `RuntimePluginFactory`를 default export하는지 확인
- [ ] `plugin.json`의 `entry`가 실제 빌드 산출물 경로를 가리키는지 확인
- [ ] LLM 파라미터 추론 테스트 후 필요시 `toolSchemas` 추가

### @lvis/plugin-sdk (Phase 2)

Phase 2에서 `packages/plugin-sdk/` 로컬 패키지 도입 예정.  
현재는 `lvis-app/src/plugins/types.ts`를 상대 경로로 import하거나 `paths` alias 설정.

```json
// tsconfig.json (플러그인)
{
  "compilerOptions": {
    "paths": {
      "@lvis/plugin-sdk": ["../../lvis-app/src/plugins/types"]
    }
  }
}
```

npm publish 파이프라인은 4개 번들 플러그인 안정화 후 확정.
