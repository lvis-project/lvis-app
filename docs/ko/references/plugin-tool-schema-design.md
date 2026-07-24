# Plugin Schema Design — LVIS

**Status:** v6 반영 (tool 계약 #885 Phase R; 이전 v4 스키마 설계 배경 포함)
**Updated:** 2026-04-18
**Architect 승인:** manifest signature + tool visibility + capability taxonomy + AJV 검증 플로우

> **tool 계약 = pure MCP `Tool[]` (#885 Phase R).** 각 tool 은
> `{ name, description, inputSchema, _meta? }` 객체이고, renderer 노출은
> `_meta.ui.visibility`, filesystem path 판정은 `_meta["lvisai/pathFields"]`,
> per-tool category 는 manifest 필드가 아니라 host 가 invocation 별로 분류한다.
> (pre-v6 의 `tools: string[]` + `toolSchemas` map + `uiActions` map + per-tool
> `category` triple 은 이 하나로 통합·제거됐다 — legacy.) 설계 배경은
> [`plugin-contract-v6-design.md`](../architecture/plugin-contract-v6-design.md).

---

## 1. 설계 원칙

플러그인은 `HostApi`를 통해 자기 자신을 등록한다. 호스트 앱은 플러그인별 코드를 포함하지 않는다.

**핵심 원칙:**

1. **Capability gate = HostApi + 선언적 capability** — HostApi 자체가 1차 게이트이며, `capabilities[]` + 각 tool 의 `_meta.ui.visibility` (renderer 노출 allowlist) 는 MS Graph · 이벤트 namespace 등 HostApi 단독으로 표현 불가능한 2차 게이트를 보강한다.
2. **SDK schema first** — 모든 `tools[]` 항목은 pure MCP `Tool` 객체로 `name`, `description`, `inputSchema`, `_meta?` 를 선언한다. path 판정은 `_meta["lvisai/pathFields"]` 가 SOT 이고, per-tool category 는 manifest 필드가 아니라 host 가 invocation 별로 분류한다 (플러그인이 자기 위험도를 스스로 매기지 않는다).
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
   * 실제 번들 플러그인(meeting / local-indexer / ms-graph) 은 모두 flat id
   * 를 사용한다. dot-form (`com.example.meeting-recorder`) 도 허용하지만 강제하지
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
   * LLM/renderer 에 노출되는 pure MCP Tool 객체 배열 (#885 Phase R — pre-v6 의
   * `tools: string[]` + `toolSchemas` map + `uiActions` map triple 을 통합 — legacy).
   * 각 tool 의 name 은 underscore 형식만 허용 (`^[a-zA-Z_][a-zA-Z0-9_]*$`).
   * 스키마·visibility·pathFields 는 아래 `Tool` 객체에 인라인.
   */
  tools: Tool[];
  config?: Record<string, unknown>;
  ui?: PluginUiExtension[];
  /** 폐쇄형 enum — §2.3 Capabilities Taxonomy 참조. */
  capabilities?: string[];
  eventSubscriptions?: string[];
  // (renderer → plugin IPC (`lvis:plugins:call`) 노출은 각 tool 의
  //  `_meta.ui.visibility` 로 선언한다 — `"app"` 을 포함한 tool 만 renderer-invokable.
  //  pre-v6 의 uiActions map 은 제거됨. §2.2 참조.)
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
  /**
   * 마켓플레이스 install 시 호스트가 사용자에게 dep 누락을 알리는 "preflight" 메타데이터.
   * **Host 는 dep 을 absolutely auto-install 하지 않는다** (issue #92, 2026-05).
   *
   * - string form `"foo"` 와 `required` 누락 object 는 `{ pluginId, required: true }` 로 정규화.
   * - `required: true` (또는 string form): dep 미설치면 install 차단 + `MissingPluginDependenciesError`.
   * - `required: false`: install 진행. 컨슈머 플러그인은 dep-absent 케이스를 graceful degrade
   *   (detector idle / envelope `{status:'<dep>_unavailable'}` 등) 해야 한다 — host 는 강제하지 않음.
   *
   * 권장 패턴: 대부분의 cross-plugin 통신은 `dependencies: [{ pluginId, required: false }]` +
   * `pluginAccess.plugins[]` 조합으로 선언한다.
   */
  dependencies?: Array<string | { pluginId: string; versionRange?: string; required?: boolean }>;
  pluginAccess?: {
    plugins: Array<{ pluginId: string; tools?: string[]; events?: string[] }>;
    /**
     * Approval scopes this plugin may issue through HostApi agentApproval.
     * Omitted means no approval scopes are granted.
     */
    agentApprovalScopes?: string[];
  };
  publisher?: string;
  /**
   * plugin start() 하드 타임아웃 (ms). `Promise.race` 기반, 초과 시 호스트가
   * 해당 플러그인을 fail-soft drop. 실제 start() 작업 자체는 AbortController
   * 미사용이므로 cancellation 되지 않는다.
   */
  startupTimeoutMs?: number;
}

// 각 tool 은 pure MCP Tool 객체 (#885 Phase R — tools/toolSchemas/uiActions triple 통합).
interface Tool {
  name: string;         // ^[a-zA-Z_][a-zA-Z0-9_]*$
  description: string;  // REQUIRED, minLength 10
  inputSchema: {
    $schema?: string;   // OPTIONAL ("http://json-schema.org/draft-07/schema#")
    type: "object";     // REQUIRED, const "object"
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  _meta?: {
    ui?: { visibility: Array<"model" | "app"> };   // renderer 노출: model=LLM, app=renderer
    "lvisai/pathFields"?: string[];              // filesystem path 판정 SOT (유일한 LVIS 전용 키)
  };
  // per-tool category 는 manifest 필드가 아님 — host 가 invocation 별로 분류.
}
```

> `python` 필드는 **더 이상 지원되지 않는다** — AJV 스키마는 `additionalProperties: false` 이므로 매니페스트에 포함하면 로드 거부. Python 런타임은 `lvis-app/src/main/python-runtime.ts` 호스트 쪽 bootstrap 로 제공되고 플러그인은 선언 없이 사용한다.

> **`version` 필드는 플러그인 저자가 통제하는 SoT.** 마켓플레이스 backend 가 자동으로 bump 하지 않는다. Release 시점에 플러그인 저자가 직접:
>
> 1. PR 으로 `plugin.json` 의 `version` 필드를 SemVer (예: `0.1.25`) 로 올림
> 2. 머지 후 main 에서 매칭 git tag 푸시 — `git tag v0.1.25 -m "release 0.1.25" && git push origin v0.1.25`
> 3. plugin repo 의 `.github/workflows/publish.yml` 이 tag-push 를 트리거로 받아 `plugin.json.version` 과 tag semver 가 일치하는지 fail-fast 검증 후 마켓플레이스 API 로 publish.
>
> 이전에는 CI 의 `bump_version.py` 가 `catalog 의 latest + 1` 으로 in-place rewrite 했지만, source `plugin.json` 과 catalog 가 갈라져서 사이드로드 (`Settings → 로컬 폴더에서 설치`) 한 플러그인에 false-positive "업데이트 있음" 배너가 떴음. **tag-as-SoT** 로 source manifest 와 catalog 가 항상 동일 — 사이드로드와 마켓플레이스 install 결과는 같은 `plugin.json` + `dist/` 레이아웃을 공유한다 (install-receipt 의 `installSource` / `signerKeyId` / `artifactSha256` 은 의도적으로 다르며 trust 표면 분리 목적).
>
> 이 룰의 enforcement 는 **각 plugin repo 의 `publish.yml` 워크플로우 안에서만** 일어난다. 호스트와 마켓플레이스 backend 는 catalog 상태를 trust 할 뿐 tag↔manifest 일치를 직접 강제하지 않는다 — discipline 은 publisher CI 에 있다 (`assertInstalledManifestMatchesCatalog` 는 호스트의 defense-in-depth 일 뿐 정문이 아님). 따라서 이 룰은 `lvis-plugin-*` 레포 전반에 적용되는 contract 이며, 모든 신규 플러그인 repo 의 `publish.yml` 이 이 패턴을 따라야 한다.
>
> branch push 는 publish 트리거 안 함 (`on.push.tags: ['v*.*.*']` 만 listen). dev 중 main 으로 머지해도 catalog 는 가만히 있음 — 의도된 release 시점에만 tag 로 트리거.
>
> **Format strictness — 4 곳에서 동일 regex** `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`:
>
> 1. `lvis-plugin-sdk/schemas/plugin-manifest.schema.json` — AJV 가 manifest 작성 시점에 거절
> 2. `lvis-app/src/plugins/runtime/manifest-validation.ts` — 호스트가 SDK schema 를 resolve 해 사이드로드 시점에 거절
> 3. 각 plugin repo (6 개) + `lvis-plugin-template` 의 `.github/workflows/publish.yml` — tag 푸시 시점에 거절
> 4. `lvis-marketplace/server/.../publisher.py` (`_SEMVER_RE`) + `schemas/plugin.schema.template.json` — POST `/api/v1/plugins/{slug}/versions` 거절
>
> Pre-release (`1.2.3-rc1`) / build-metadata (`1.2.3+abc`) / leading-zero (`01.2.3`) 모두 5 곳에서 거절. 한 곳 풀어주려면 5 곳 같이 풀어야 (`host-plugin-contract-sync` 룰 적용).
>
> 같은 strictness 가 `tools[].version` 과 `tools[].deprecatedSince` 에도 적용 (SDK + host AJV schema). publish.yml 의 tag-validation gate 는 top-level `version` 만 보므로 tool-level version 의 enforcement 정문은 AJV.

**각 필드의 런타임 소비처:**

| 필드 | 소비처 | 타이밍 |
|----------------------------- |--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |------------------------------------------- |
| `id` | PluginRegistry, HostApi cleanup | boot + 런타임 전반 |
| `version` | 마켓플레이스 카탈로그 카드 + update-detector 비교 + install receipt + `assertInstalledManifestMatchesCatalog` (defense-in-depth host check) + Settings UI 카드 | install + 런타임 전반 |
| `icon` | plugin grid v3 popover (Lucide named-export 동적 lookup, 누락/매치 실패 시 `Plug` fallback). 옵션 필드 — 없으면 default 아이콘 | UI 렌더 |
| `iconText` | plugin grid v3 popover — 짧은 텍스트 라벨 (1-4자, 예: `"EP"`, `"MTG"`) 을 Lucide 아이콘 대신 아바타 안에 렌더. 둘 다 선언 시 `iconText` 우선. 적당한 Lucide 글리프가 없는 도메인-내부 식별자에 사용. 옵션 필드 | UI 렌더 |
| `entry` | runtime.ts `require()` | boot |
| `tools[]` (Tool 객체) | Tool Registry 등록 + LLM system prompt tool schema (`inputSchema`/`description`) | boot ToolRegistry 등록 + system prompt 빌드 |
| `description` | 비활성 플러그인 카탈로그 (`listPluginCards`) | system prompt · UI |
| `ui[]` | plugin-ui-host.tsx 마운트 | boot + UI 렌더 |
| `eventSubscriptions[]` | 호스트 이벤트 라우팅 | boot |
| `notificationEvents[]` | `registerPluginNotifications()` — OS 알림 자동 등록 | boot |
| `tools[]._meta.ui.visibility` | `PluginRuntime.callFromUi()` app-visible allowlist | renderer IPC 호출 |
| `capabilities[]` | HostApi MS Graph 게이트 + `emitEvent` namespace 게이트 | 런타임 전반 |
| `installPolicy` | Install-policy guard + signature gate policy | install + uninstall + load |
| `dependencies` | Marketplace install **preflight gate**. `required:true` (default — string form / `required` 누락 object 포함) 미설치 시 install 거부 + `MissingPluginDependenciesError`; `required:false` 는 install 통과 + 컨슈머 책임으로 degrade. **Host 는 dep 을 auto-install 하지 않는다** (issue #92). | install |
| `pluginAccess` | Cross-plugin tool/event access gate + agent approval scope grant | runtime |
| `publisher` | 감사 로그 · 마켓플레이스 카드 | install + 표시 |

**plugin.json 권한 메타데이터 예시 (meeting 플러그인의 핵심 도구 발췌):**

```json
{
  "id": "meeting",
  "name": "LVIS Meeting",
  "version": "0.3.2",
  "description": "회의 녹음·음성 전사(STT)·요약 생성 플러그인.",
  "entry": "dist/hostPlugin.js",
  "capabilities": ["meeting-recorder"],
  "tools": [
    {
      "name": "meeting_start",
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
      },
      "_meta": { "ui": { "visibility": ["model"] } }
    },
    {
      "name": "meeting_push_chunk",
      "description": "PCM16LE 오디오 청크를 세션에 추가. STT는 비동기 처리.",
      "inputSchema": {
        "type": "object",
        "required": ["sessionId", "chunk"],
        "properties": {
          "sessionId": { "type": "string" },
          "chunk": { "type": "object" }
        }
      },
      "_meta": { "ui": { "visibility": ["model"] } }
    },
    {
      "name": "meeting_stop",
      "description": "회의 녹음 세션을 종료하고 최종 전사 요약 생성을 요청한다.",
      "inputSchema": {
        "type": "object",
        "required": ["sessionId"],
        "properties": { "sessionId": { "type": "string" } }
      },
      "_meta": { "ui": { "visibility": ["model"] } }
    },
    {
      "name": "meeting_transcript",
      "description": "저장된 회의 세션의 전사 텍스트를 조회한다.",
      "inputSchema": {
        "type": "object",
        "required": ["sessionId"],
        "properties": { "sessionId": { "type": "string" } }
      },
      "_meta": { "ui": { "visibility": ["model", "app"] } }
    },
    {
      "name": "meeting_sessions",
      "description": "사용 가능한 회의 세션 목록을 조회한다.",
      "inputSchema": { "type": "object", "properties": {} },
      "_meta": { "ui": { "visibility": ["model", "app"] } }
    }
  ],
  "installPolicy": "user",
  "publisher": "example-publisher"
}
```

---

### 2.1 마켓플레이스 artifact 검증

플러그인 repo는 `plugin.json` sidecar signature를 만들지 않는다. Marketplace upload API가 manifest/schema/policy/access를 검증하고 최종 artifact envelope를 서명한다. Host는 설치 시 envelope를 검증하고 install receipt를 저장하며, runtime load 전에 receipt의 file hash를 확인한다.

| 상황 | 정책 |
|-------------------------------------- |--------------------------------------------------------------------- |
| envelope 검증 성공 + receipt hash 일치 | 로드 후보. `plugin_integrity_verified` 감사 이벤트 기록. |
| envelope 검증 실패 | 설치 거부. |
| receipt 누락/불일치 | **드롭 (fail-closed)**. `plugin_integrity_rejected` 감사 이벤트 기록. |

마켓플레이스 trust anchor는 host-owned `src/plugins/marketplace-keys.ts`에 있다. `@lvis/plugin-sdk`는 type/source-only 계약이며 키를 포함하지 않는다.

**`installLocal` (개발자 sideload) 패키징 — host 가 자동 제외하는 경로**: host 의 `buildSideloadCopyFilter` (`src/plugins/sideload-filter.ts`) 는 install 시 다음 subtree 를 건너뛴다 — 플러그인 런타임에 무관하면서 staging 단계에서 깨지는 컨텐츠라 자동 제외:

- `node_modules/electron`, `node_modules/@electron/*` — Electron 번들 `.asar` 가 patched fs 에 의해 "Invalid package" 로 폭사
- `node_modules/.bin/` — npm/pnpm 이 만드는 dev-only 쉘 shim 들. 위에서 electron 패키지가 제외되면 `.bin/electron` 이 dangling 으로 남고 후속 `rejectEscapingSymlinks` 가 fail-closed 거부
- `.git/` — VCS 메타데이터, 사이즈/프라이버시

플러그인 런타임은 `.bin/` 쉘 shim 을 spawn 하지 않으므로 (in-process import 만), 위 제외는 손실 없음. 만약 플러그인이 위 경로 안의 파일에 의존한다면 — 예컨대 `dist/` 로 번들링하거나 manifest 가 명시적 자산 선언이 필요한지 다시 검토 필요.

### 2.2 app-visibility 보안 경계

Renderer UI 는 `lvis:plugins:call` IPC 를 통해 app-visible 플러그인 tool 호출을 요청할 수 있다. 이 IPC 는 handler 직접 호출 경로가 아니며, `PluginRuntime.callFromUi()` 가 매번 tool 의 `_meta.ui.visibility` 를 재확인한다 — `"app"` 을 포함한 tool 만 renderer-invokable 이고 나머지는 거부된다. visibility 에 `"model"` 이 있으면 LLM-facing, `"app"` 이 있으면 renderer-facing 이며, 겸용 tool 은 ToolExecutor 권한 경로를 통과하고, app-only tool (`["app"]`) 은 auth status polling 을 제외하고 preload 가 확인한 active user activation 이 있어야 handler 로 전달된다. (pre-v6 의 `tools[]` + `uiActions` map 별도 surface 는 #885 Phase R 에서 이 하나의 visibility 배열로 통합됨.)

**규칙:**

1. **하나의 tool, visibility 로 surface 결정** — `["model"]` = LLM 전용, `["app"]` = renderer 전용(app-only), `["model","app"]` = 겸용. auth/status/login/panel-internal 메서드는 `["app"]` 로 둔다.
2. **권한 경로 분리** — `PluginRuntime.callFromUi(method, payload)` 는 매번 tool 의 visibility 를 재확인한 뒤 host delegate 로 넘긴다. visibility 에 `"model"` 이 있으면 ToolExecutor 를 호출하므로 sensitive path, allowed directories, reviewer, hooks, audit 정책이 적용된다. `["app"]` app-only tool 은 auth status polling 을 제외하고 active user activation 이 있어야 실행되며, runtime 이 visibility 재검증과 audit log 를 남긴다.
3. **도구 이름 제한 없음** — 어떤 접미사든 `"app"` visibility 로 노출할 수 있다. 실제 위험 작업은 이름이 아니라 `_meta["lvisai/pathFields"]` 와 host-classified category 로 평가한다.

**예시 (`_meta.ui.visibility`):**

```jsonc
// OK — read-only 조회 메서드 (겸용)
{ "name": "meeting_transcript", "_meta": { "ui": { "visibility": ["model", "app"] } } }
{ "name": "meeting_sessions",   "_meta": { "ui": { "visibility": ["model", "app"] } } }

// OK — 파괴적 동작도 app-visible 로 노출 가능. 플러그인이 자체 UI 에서 확인 다이얼로그를 구현해야 함
{ "name": "msgraph_email_reply",     "_meta": { "ui": { "visibility": ["model", "app"] } } }
{ "name": "msgraph_calendar_delete", "_meta": { "ui": { "visibility": ["model", "app"] } } }

// OK — UI 전용 메서드 (app-only). LLM에는 노출되지 않음
{ "name": "meeting_push_chunk", "_meta": { "ui": { "visibility": ["app"] } } }
```

### 2.3 capabilities Taxonomy (Phase 5)

`capabilities[]` 는 **폐쇄형 enum** 이다 (`src/plugins/capabilities.ts` 의 `KNOWN_CAPABILITIES`). 등록되지 않은 문자열은 AJV+런타임에서 거부된다.

| 값 | 강제/자문 | 역할 |
|------------------------ |-------------------- |------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ms-graph-consumer` | advisory (PR 3 이후) | Microsoft Graph 를 사용하는 플러그인의 자기-식별 라벨. PR 3 에서 host 측 MS HostApi 메서드가 모두 제거되어 강제할 게이트가 없으므로 advisory 로 강등. ms-graph 플러그인이 자체 MSAL + safeStorage 로 직접 인증 처리 (architecture.md §9.4a "Plugin-Owned OAuth Authentication" 참조). |
| `external-auth-consumer` | **enforced** | `openAuthWindow` 호출 필수. 실 Chromium 창을 띄워 외부 포털 세션 쿠키를 수집하는 민감 operation — 선언적 opt-in 없이는 거부. |
| `mail-source` | **enforced** | `email.*` 이벤트 emit 게이트. 미선언 시 emit 이 드롭되고 warn. |
| `calendar-source` | **enforced** | `calendar.*` emit 게이트. |
| `meeting-recorder` | **enforced** | `meeting.*` emit 게이트. |
| `knowledge-index` | **enforced** | `index.*` emit 게이트. |
| `background-watcher` | advisory | 플러그인 자체 lifecycle (`start()` hook) 에서 폴러/감시자를 기동한다는 선언. 런타임 게이트 없음 (향후 enforce 예정). |
| `worker-client` | advisory | 외부 프로세스(Python uv 등) 워커 래퍼 선언. |
| `lifecycle-observer` | advisory | `getInstalledPluginIds` / `onPluginsChanged` 사용 선언 |
| `host:overlay` | **enforced** | `triggerConversation()` 호출 필수. 사용자가 입력하지 않은 plugin-authored prompt 를 host overlay 에 staged 하고, 사용자 확인 후 main chat 에 삽입하는 surface — 일반 plugin 에 부여하지 말 것. 자세한 설계는 [`overlay-trigger.md`](./overlay-trigger.md) 참조. |

**이벤트 subscription 정책** (`classifySubscription`):

- `memory.private.*`, `settings.apiKey.*`, `audit.*`, `dlp.*` → `PLUGIN_PRIVATE_NAMESPACES` 에 매칭되어 **subscription 거부** (wiring 시 throw).
- `meeting`, `calendar`, `email`, `index` → public. 조용히 허용. `task.*` namespace 는 host owner (`TaskDeadlinePoller` / `TaskService`) 가 2026-05-05 Phase 4 에서 제거되며 폐기되었고, 도메인은 플러그인 측 plugin-bus 이벤트로 이전되었다 (2026-05-11 정리).
- 그 외 → neutral. 허용하되 namespace drift 추적 warn. **플러그인-소유 도메인 namespace (어떤 single-publisher 플러그인이 owner 인 경우) 는 의도적으로 public 으로 승격하지 않는다** — host 가 특정 플러그인 id 를 알면 안 된다는 `open-source-readiness` 룰 때문. 구독 측은 load-time warn 한 줄을 받지만 wiring 은 그대로 동작하며, emit 측 cross-plugin spoof 는 HostApi pluginId 바인딩으로 차단된다.

**이벤트 emit 측 host-only 예약** (`HOST_ONLY_EMIT_NAMESPACES` in `src/plugins/capabilities.ts`):

| Namespace | 발행자 | 비고 |
|----------|--------------------------------------- |-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin.*` | host (`emitEvent` from `boot/types.ts`) | `plugin.installed` / `plugin.uninstalled` lifecycle. plugin 의 `hostApi.emitEvent` 와 plugin webview IPC bridge 양쪽 모두 거부. plugin lifecycle subscriber 는 `onPluginsChanged` self-event filter + `source` discriminator 로만 구독한다. 자세한 contract 는 architecture.md §9.4a. |
| `host.*` | host main process | UI / 환경 상태 broadcast. plugin 측 emit 거부. plugin webview SDK 가 `bridge.onEvent("host.<axis>", h)` 로 구독. 현재 발행 이벤트: `host.theme.changed` (theme/chatTheme/codeTheme + computed `--lvis-*` tokens) — register 시점에 preload 가 sticky-buffer 로 1회 replay 보장 (자세한 흐름은 architecture.md §6.7.1). 추후 `host.locale.changed`, `host.online.changed` 등 추가 가능. |

~~`task.*` 도 사실상 host-only 지만 별도 set 에 등록하지 않음~~ **(2026-05-11 stale)** `task.*` 는 PUBLIC_EVENT_NAMESPACES 에서 제거됨 (host owner Phase 4 폐기). 후속 task-도메인 신호는 플러그인 측 plugin-bus 이벤트로 이전 — host 는 그 namespace 를 모른 채 neutral 분류로 라우팅한다.

`onPluginsChanged` 의 `PluginLifecycleEvent` union 에는 `_future` sentinel variant (`{type: "_future"; readonly __exhaustive: never}`) 가 포함된다. 런타임에는 절대 발생하지 않으며, 향후 `"updated"` 같은 신규 variant 추가 시 exhaustive `switch (event.type)` consumer 가 silently 누락되지 않도록 `default:` branch 를 강제하는 type-level forward-compat 가드다.

### 2.4 `auth` — Plugin-Owned OAuth 의 Host UI Surface

OAuth-flow 를 소유한 플러그인 (ms-graph, ms-graph 등) 이 호스트 Settings UI 에 generic 미인증 / 인증됨 뱃지 + 로그인/로그아웃 버튼을 제공하기 위한 _선언적_ 계약. 호스트는 OAuth 코드를 모르고, 단지 manifest 에 적힌 tool 이름을 dispatch + standardized 이벤트를 listen 한다. architecture.md §9.4a "Plugin-Owned OAuth — Host UI Surface" 와 짝.

**Manifest 형**

```jsonc
{
  "tools": [
    { "name": "msgraph_status",  "description": "인증 상태를 반환한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
    { "name": "msgraph_auth",    "description": "로그인 플로우를 시작한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
    { "name": "msgraph_signout", "description": "로그아웃한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
  ],
  "auth": {
    "label": "Microsoft 계정",      // optional; 기본 manifest.name
    "statusTool": "msgraph_status",  // 필수, visibility ["app"]
    "loginTool": "msgraph_auth",     // 필수, visibility ["app"]
    "logoutTool": "msgraph_signout", // optional, visibility ["app"]
  },
}
```

**Cross-field 강제** — `manifest-validation.ts` (§B-3 와 같은 hand-rolled 위치) 가 `auth.{statusTool,loginTool,logoutTool}` 이 가리키는 tool 의 `_meta.ui.visibility` 가 **정확히 `["app"]`** (app-only, model 노출 금지) 임을 load-time 에 검증. AJV 단독으로는 cross-object membership 표현 불가.

**StatusTool 반환 (recommended)**

```ts
interface PluginAuthStatusResult {
  authenticated: boolean;
  account?: string;  // 이메일 / 로그인 ID 등 human-readable
}
```

호스트 defensive parse — 추가 필드는 무시. `outputSchema` 강제 검증은 별 PR 로 tool outputSchema 인프라 작업 후 도입.

**`<pluginId>.auth.changed` 이벤트** — 인증 전이 시 plugin 이 emit. `manifest.emittedEvents[]` 등록 필수. 호스트 `usePluginAuthStatuses` 훅이 받아 statusTool 재호출 → 뱃지 갱신. **폴링 안 함.** `lvis-plugin-ms-graph` / `lvis-plugin-corp-portal` 가 PR 와 함께 emit 흐름 추가.

> **이름 규칙**: `<pluginId>` 는 manifest `id` 필드 literal — `_`↔`-` 정규화 없음. tool 이름 prefix (`meeting_*`, `agent_hub_*`) 와 다른 형식이라 mirror 하지 말 것. 예) `id: "foo-bar"` (dash) 인 플러그인의 auth 이벤트는 정확히 `foo-bar.auth.changed` 여야 하며, `foo_bar.auth.changed` (underscore) 는 host hook 의 strict subscribe 와 매치 안 되어 뱃지 stuck. `manifest-validation.ts` 의 cross-field check 가 `auth` 선언 시 `emittedEvents[]` 에 `${id}.auth.changed` 가 빠져있으면 load-time `log.warn` 발행 — 같은 룰이 architecture.md §9.4a 에 명시됨.

**예시 (ms-graph 플러그인)**

```jsonc
{
  "tools": [
    /* non-auth LLM tools ... */
    { "name": "msgraph_status",  "description": "인증 상태를 반환한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
    { "name": "msgraph_auth",    "description": "로그인 플로우를 시작한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
    { "name": "msgraph_signout", "description": "로그아웃한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
  ],
  "emittedEvents": ["ms-graph.auth.changed" /* ... */],
  "auth": {
    "label": "Microsoft 계정",
    "statusTool": "msgraph_status",
    "loginTool": "msgraph_auth",
    "logoutTool": "msgraph_signout",
  },
}
```

#### 2.4.1 `auth.partitionDomains` — 파티션 뷰어 allow-list (#649)

OAuth-flow 를 소유한 플러그인이 자기 `persist:plugin-auth:<pluginId>` 파티션 안에서 외부 페이지(예: Outlook 캘린더 web UI)를 열기 위한 _hostname allow-list_. `hostApi.openAuthPartitionViewer({ url })` 호출이 이 리스트를 게이트로 사용한다 — URL 의 host 가 리스트에 매치되지 않으면 즉시 throw + audit.

**매칭 룰** — dot-boundary suffix-match. `outlook.office.com` 가 리스트에 있으면:
- `outlook.office.com` ✅
- `mail.outlook.office.com` ✅
- `outlook.office.com.attacker.com` ❌ (전형적인 typosquat)
- `notoutlook.office.com` ❌

**거부 패턴** — SDK schema 와 호스트 `host-allow-list.ts` 가 보안적으로 중요한 패턴을 **둘 다** 거부한다 (hand-edited manifest 가 schema 를 우회해도 호스트가 한 번 더 잡음). 형식 오류성 패턴은 SDK schema 만 publish-time 에 거부한다 (호스트는 단순히 매칭 실패로 처리되어 dead entry 가 됨).

| 패턴 | SDK schema | 호스트 | 거부 이유 |
|------------------------------------------------------------------------------ |------------- |----------------------- |------------------------------------------------------------------------ |
| `*`, `*.office.com` | ✅ | ✅ | wildcard 는 모든 sub-domain 매치 → blanket consent surface |
| `localhost`, `intranet` | ✅ | ✅ | single-label 은 동일 등록자 suffix 의 모든 site 와 blanket-match |
| `com`, `co.kr`, `or.kr`, `go.kr`, `kr`, `net`, `org`, `io`, `ai`, `dev`, `app` | ✅ | ✅ | 공개 등록 suffix — 모든 등록자 site 와 blanket-match |
| `https://outlook.office.com/path` | ✅ | ✅ (slash detection) | URL/path → host 만 받음 |
| `xn--80ak6aa92e.com` | ✅ | ✅ | IDN-punycode 는 homoglyph 위험 (e.g. `аррӏе.com`); ASCII brand domain 만 |
| (entry 17개 이상) | ✅ (maxItems) | ✅ (`MAX_HOSTS=16`) | over-broad consent surface |
| `Outlook.Office.com` | ✅ | (lowercase 정규화) | schema 는 소문자만 허용; 호스트는 정규화 후 매칭 |
| `outlook.office.com:443` | ✅ | (매칭 실패, dead entry) | URL.hostname 에 포트가 없어 매칭 안 됨 |
| `outlook..office.com`, `-foo.com`, `foo-.com`, `.outlook.com`, `outlook.com.` | ✅ | (매칭 실패, dead entry) | 정상 URL hostname 과 매칭 안 됨 |
| (label > 63자 또는 hostname > 253자) | ✅ (RFC 1035) | (매칭 실패, dead entry) | 정상 URL 에 그런 host 없음 |

**3 layer defense** — 매니페스트 publish 시 SDK schema 가 한 번, 호스트 load 시 `normalizeAllowedHosts` 가 한 번, viewer-open 호출 시 `urlHostMatchesAllowList` 가 한 번.

**선택 필드** — 플러그인이 `openAuthPartitionViewer` 를 호출하지 않으면 `partitionDomains` 생략 가능. 호출하면서 빈 리스트 / 미선언이면 `external-auth-consumer` capability 가 있어도 거부.

**`external-auth-consumer` capability 와의 관계** — partition viewer 는 `openAuthWindow` 와 동일한 cookie jar 에 접근하므로 capability 게이트도 동일 (`external-auth-consumer`). 즉 viewer 호출 플러그인은:

1. `capabilities[]` 에 `external-auth-consumer` 선언
2. `auth.partitionDomains[]` 에 non-empty hostname 리스트 선언
3. (선택) `auth.{statusTool, loginTool, logoutTool}` 로 host UI 뱃지/버튼 surface 활성화

**예시 (ms-graph 플러그인 — Outlook 캘린더 뷰어 surface 추가)**

```jsonc
{
  "id": "ms-graph",
  "capabilities": ["external-auth-consumer"],
  "tools": [
    { "name": "msgraph_open_outlook_calendar", "description": "Outlook 캘린더 뷰어를 연다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["model", "app"] } },
    },
    /* ... 기타 tool ... */
    { "name": "msgraph_status",  "description": "인증 상태를 반환한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
    { "name": "msgraph_auth",    "description": "로그인 플로우를 시작한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
    { "name": "msgraph_signout", "description": "로그아웃한다.", "inputSchema": { "type": "object", "properties": {} }, "_meta": { "ui": { "visibility": ["app"] } },
    },
  ],
  "emittedEvents": ["ms-graph.auth.changed"],
  "auth": {
    "label": "Microsoft 계정",
    "statusTool": "msgraph_status",
    "loginTool": "msgraph_auth",
    "logoutTool": "msgraph_signout",
    "partitionDomains": [
      "outlook.office.com",
      "login.microsoftonline.com",
      "office365.com",
    ],
  },
}
```

### 2.5 AJV 매니페스트 검증 플로우

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
│ 2. AJV schema validation         │  Host schemas/plugin-manifest.schema.json
│    (strict, allErrors, formats)  │  → 실패 시
│                                  │     [manifest:<pid>] schema validation failed: <errs>
└──────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────┐
│ 3. Cross-field checks            │  runtime.ts readManifest()
│    - tool name regex             │
│    - auth tool visibility==["app"]│
│      (app-only; model 노출 금지)   │
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
[manifest:<unknown>] JSON parse error (Unexpected token ...). Example: {"id":"com.example.sample",...}
[manifest:meeting] schema validation failed (/path/to/plugin.json): /tools/0/name must match pattern "^[a-zA-Z_][a-zA-Z0-9_]*$"
Invalid tool name 'meeting.start' in plugin 'meeting' at 'tools[0]' (/path/to/plugin.json): tool names must match ^[a-zA-Z_][a-zA-Z0-9_]*$ (start with letter/underscore, then letters/digits/underscores). Example: "tools": ["meeting_start"] (not "meeting.start")
[plugin-runtime] managed plugin 'lvis-plugin-ms-graph' rejected — signature invalid
[plugin-runtime] managed plugin 'meeting' rejected — signature file missing
```

각 단계는 fail-soft drop (해당 플러그인만 제외하고 나머지는 계속 로드).

---

### 2.6 UI Styling Tokens — `--lvis-*` 화이트리스트

플러그인 UI 는 호스트가 broadcast 하는 17 개의 `--lvis-*` 디자인 토큰만 사용해야
한다 (architecture.md §6.7.1 의 `host.theme.changed` 흐름 참조). 호스트의
`validateThemePayload` (`src/ipc/domains/plugins.ts` `PLUGIN_TOKEN_NAMES`) 가
broadcast 시점에 같은 화이트리스트로 silently drop 하므로, 그 외 토큰을 참조하면
런타임에 CSS `initial` 키워드로 렌더되어 invisible regression 이 된다.

**Authoring 규칙**:

1. **참조** — `var(--lvis-bg)` / `var(--lvis-fg-muted)` 등. 17 개 SoT 는 SDK
   `@lvis/plugin-sdk/ui/tokens` 의 `LVIS_TOKEN_NAMES` 가 canonical (host 의
   `PLUGIN_TOKEN_NAMES` 는 broadcast-side mirror). 두 곳은 lockstep 갱신 — 한쪽만
   추가하면 broadcast 가 새 토큰을 drop 하거나 SDK 가 정의되지 않은 토큰을 노출.
2. **재정의 금지** — 플러그인 코드 어디서도 `--lvis-*: ...` 선언 (예: `:root`
   override) 을 두면 안 된다. 호스트가 canonical 값의 owner. 재정의는 chat-theme
   / accent toolbar / dark-light 전환 등 host-driven UX 와 충돌.
3. **번들 경로** — JSX 속성 안 quoted string (`stroke="var(--lvis-fg)"`) 은
   build-time validator 가 못 보는 위치다 (string strip 단계에서 erase). 토큰
   참조는 항상 `injectTokenCss` 의 template-literal CSS 블록에 두자. SDK 컴포넌트
   가 모두 같은 패턴.
4. **Mount contract — `primeTheme` 가 첫 await** (Decision 2026-05-12) —
   플러그인의 `mount()` (또는 entry module) 는 React render / vanilla DOM
   build 이전에 `primeTheme(bridge, opts?)` 를 호출해야 한다. 이 헬퍼가
   `lvisPlugin.getTheme()` pull + paint + `host.theme.changed` 구독 3 경로를
   캡슐화하므로 플러그인 측 글루 코드는 한 줄로 줄어든다. detached
   BrowserWindow / scoped sidebar 는 `opts.target` (`Document | HTMLElement`)
   으로 가리키고, sidebar custom 토큰 매핑 같은 use-case 는 `opts.onPayload`
   콜백으로 흡수한다 (별도 `bridge.onEvent("host.theme.changed", …)` 두 번째
   구독 금지 — drift 회귀 케이스). React 측은 `useTheme(bridge, opts?)` 가
   `primeTheme` 위의 얇은 wrapper 라 동일 옵션 surface 를 갖는다. 자세한
   결정 근거 + 마이그레이션 시퀀스는 `docs/architecture/proposals/2026-05-12-plugin-theme-unification.md`
   참조.

```ts
// React 플러그인 — App 최상위
import { useTheme } from "@lvis/plugin-sdk/ui/hooks/useTheme";

function App({ bridge, rootEl,
}: { bridge: PluginBridge; rootEl?: HTMLElement;
}) {
  useTheme(bridge, {
    target: rootEl,                            // 옵션: scoped root 가 있을 때만
    onPayload: (e) => mapSidebarTokens(e),     // 옵션: custom 매핑
  });
  // …
}

// Vanilla 플러그인 — mount entry (detached window 포함)
import { primeTheme } from "@lvis/plugin-sdk/ui/hooks/primeTheme";

export function mount(host: PluginHost): PluginInstance {
  const { dispose } = primeTheme(host.bridge, {
    target: host.targetDocument ?? document,
  });
  // … plugin DOM build …
  return { unmount: () => { dispose(); /* … */ },
  };
}
```

**Build-time validator** (SDK v3.8.0+):

```ts
// scripts/check-ui-tokens.mjs
import { validateTokenUsage, validateTokenDefinitions,
} from "@lvis/plugin-sdk/ui/tokens/validate";

const css = readFileSync("src/ui/MyComponent.tsx", "utf8");
const usage = validateTokenUsage(css);
if (!usage.ok) {
  console.error("Unknown --lvis-* references:", usage.unknown);
  process.exit(1);
}
const defs = validateTokenDefinitions(css);
if (!defs.ok) {
  console.error("Plugins must not redefine --lvis-* tokens:", defs.forbiddenRedefinitions,
  );
  process.exit(1);
}
```

순수 string-scan (postcss 의존성 0). `lvis-plugin-template` 의
`scripts/check-ui-tokens.mjs` + `.github/workflows/validate-ui-tokens.yml` 이
canonical 예시 — 새 플러그인은 템플릿에서 fork 하면 자동 보호.

**SoT 동기화 정책**:

- SDK `LVIS_TOKEN_NAMES` (canonical) ← host `PLUGIN_TOKEN_NAMES` 가 lockstep.
- `lvis-plugin-sdk` 의 `scripts/sync-from-host.mjs` 가 host plugins.ts 에서 토큰
  명단을 추출해 SDK `src/ui/tokens/index.ts` 에 반영 (drift-check workflow 가
  매일 + PR 마다 실행) — 호스트만 갱신 후 SDK 동기화 누락 케이스 차단.
- 새 토큰 추가 시: host `PLUGIN_TOKEN_NAMES` + SDK `LVIS_TOKEN_NAMES` +
  `lvis-tokens.css :root` + first consumer (or reserved 마커) 한 PR 안에서
  lockstep. 위반 시 architect P0 follow-up.

**Import 패턴 (SDK v3.10.0+)**:

플러그인이 SDK UI primitive 를 쓸 때는 **per-component subpath** 가 canonical.
barrel `@lvis/plugin-sdk/ui` 는 모든 컴포넌트의 `injectTokenCss` side-effect 를
끌어와 tree-shake 안 됨 → 한 컴포넌트만 써도 전체가 번들됨.

```ts
// canonical
import { Stack, Inline } from "@lvis/plugin-sdk/ui/components/Stack";
import { Toggle } from "@lvis/plugin-sdk/ui/components/Toggle";

// legacy / prototyping
import { Stack, Toggle } from "@lvis/plugin-sdk/ui";
```

자세한 subpath 목록 + dedup-by-id 계약은 `lvis-plugin-sdk` README "UI imports".
번들 크기 절감 효과는 host-provided React 결정 (`lvis-plugin-sdk` issue #103) 후
의미가 커짐 — 그 전엔 React 1MB 가 dominant 라 subpath 효과가 시각적으로 안
드러남. 그러나 import 자체는 항상 subpath 가 정도.

> Subpath 명단의 SoT 는 `lvis-plugin-sdk/package.json` 의 `exports` 필드 —
> 본 문서의 예시는 illustrative. SDK 가 새 컴포넌트를 추가하거나 경로를
> rename 하면 SDK CHANGELOG / README 가 권위 있는 참조.

---

## 3. Tool inputSchema 작성 가이드

각 tool 객체는 `inputSchema` (JSON Schema draft-07) 를 담는다. filesystem path 인자는 `_meta["lvisai/pathFields"]` (Layer 0/1/5 path 검사 입력) 로 선언하고, per-tool category 는 manifest 필드가 아니라 host 가 invocation 별로 분류한다. top-level 은 반드시 `"type": "object"` — 모든 LLM vendor 공통 요구사항. (pre-v6 의 `toolSchemas` map 은 #885 Phase R 에서 tool 객체로 인라인됨.)
`description` 은 **필수** (`minLength: 10`) — 10자 미만이면 AJV 가 거부한다.

### 예시 1: meeting_push_chunk (바이너리 데이터 포함)

```json
{
  "name": "meeting_push_chunk",
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
  },
  "_meta": { "ui": { "visibility": ["app"] } }
}
```

> **교훈**: `pcm16leMono`는 TypeScript에서 `number[]`로 전달된다. JSON Schema `items.type: "integer"`로 LLM에 명시하지 않으면 LLM이 base64 string을 시도할 수 있다.

### 예시 2: msgraph_calendar_create (nested required + attendees 배열)

```json
{
  "name": "msgraph_calendar_create",
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
  },
  "_meta": { "ui": { "visibility": ["model", "app"] } }
}
```

### 예시 3: msgraph_email_reply (사전 조건 명시)

```json
{
  "name": "msgraph_email_reply",
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
  },
  "_meta": { "ui": { "visibility": ["model", "app"] } }
}
```

**작성 체크리스트:**

- [ ] top-level `"type": "object"` 선언
- [ ] `description` 10자 이상 (AJV `minLength: 10`)
- [ ] 파일 경로 인자가 있으면 `_meta["lvisai/pathFields"]` 에 dotted selector 로 선언 (per-tool category 는 host 가 분류 — manifest 에 선언 안 함)
- [ ] `required` 배열에 필수 파라미터 명시
- [ ] `description`으로 LLM에 사전 조건 전달 (예: "먼저 X를 호출해야 함")
- [ ] enum 값이 있으면 `enum` 키 사용 (LLM 환각 방지)
- [ ] 선택 필드는 `required`에서 제외 (null 강요 금지)

---

## 4. HostApi 메서드

플러그인이 호스트에 접근하는 유일한 경로. `PluginHostApi` 인터페이스 (`src/plugins/types.ts`).

| 메서드 | 언제 쓰나 | 언제 쓰지 말아야 하나 |
|--------------------------------- |-------------------------------------------------------------------------------------------------- |------------------------------------------------------- |
| `emitEvent(name, payload)` | 다른 플러그인·호스트 이벤트 버스에 이벤트 발행 (capability gate) | 직접 플러그인 간 함수 호출 대체 |
| `onEvent(name, handler)` | 다른 플러그인 이벤트 구독 (private namespace 차단) | 폴링 대체 (push 모델로 충분) |
| `addTask(task)` | 액션 아이템 → LVIS 태스크 자동 생성 (host `taskService` → `~/.lvis/tasks/lvis-tasks.db` SQLite). | UI 직접 조작 대체 |
| `saveNote(title, content)` | `~/.lvis/plugins/<id>/notes/`에 회의록·요약 저장 (플러그인 namespace 내부) | 대용량 바이너리 저장 |
| `getSecret(key)` | 암호화된 API 키 조회 | 키를 메모리에 캐시 후 재사용 (매번 호출) |
| (플러그인 간 직접 tool 호출 없음) | 다른 플러그인에게 작업을 요청하거나 결과를 받으려면 `emitEvent` / `onEvent` 이벤트 계약으로 모델링 | peer plugin module import, handler 직접 호출, 권한 우회 |
<!-- PR 3c: getMsGraphToken / startMsGraphAuth / isMsGraphAuthenticated / getMsGraphAccount / onMsGraphAuthChange / withMsGraphRetry — host HostApi 에서 제거됨. ms-graph 플러그인이 자체 MSAL 소유. architecture.md §9.4a "Plugin-Owned OAuth Authentication" 참조. -->
| `callLlm(prompt, options?)` | 호스트 LLM 으로 단발 텍스트 생성 (플러그인 분류·요약) | 대화 히스토리·streaming·tool_use 필요 시 (플러그인이 직접 SDK 사용) |
| `openAuthWindow(options)` ([external-auth-consumer] 필요) | 외부 포털 interactive 로그인 창을 띄우고 지정 도메인 쿠키 수집 (Selenium/webdriver 대체) | OAuth-style localhost callback이 되는 표준 플로우 (→ MS Graph 패턴 사용) |
| `triggerConversation(spec)` ([host:overlay] 필요) | 관찰된 신호를 바탕으로 overlay prompt 를 host overlay 에 staged | 사용자 input → tool 결과 패턴 (chat 으로 충분) — 자세한 사용 패턴 / 안전 계약은 [`overlay-trigger.md`](./overlay-trigger.md) |
| `getInstalledPluginIds()` | 다른 플러그인 설치 여부 체크 — 의존성-인식 detector / 조건부 UI | 우선순위 추론 (insertion order ≠ priority). 향후 capability-filtered 변종 (`getProvidersFor(capability)`) 가 superseding 예정 — Phase 1 은 unscoped |
| `onPluginsChanged(handler)` | install/uninstall 발생 시 reactive 재구성 (예: detector list rebuild). handler 는 `PluginLifecycleEvent` 받음 (`{type, pluginId, source}` discriminated union, self-event 자동 필터). production consumer 는 `source: "local-dev"` 무시 권장 | `updated` (버전 bump) — 별도 spec 진행 중 (P0 미지원). handler 는 forward-compat 위해 `default:` 분기 필수 |
| `logEvent(level, message, data?)` | 호스트 감사 로그에 플러그인 이벤트 기록 | 디버그 전용 고빈도 로깅 (성능) |
| `onShutdown(handler)` | 앱 종료 전 정리 작업 (DB flush, 파일 저장 등) | 긴 비동기 작업 (5s 제한) |

### callLlm 상세 (§B-7)

```typescript
// 플러그인이 선제성 제안 본문을 생성하는 예
const suggestion = await hostApi.callLlm(
  `다음 이메일이 미팅 제안인지 판단하고, 제안이면 제목·일시를 한국어로 요약: ${emailBody}`,
  { maxTokens: 300, systemPrompt: "당신은 캘린더 보조 비서입니다." },
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
// 플러그인이 포털 쿠키를 수집하는 예
const cookies = await hostApi.openAuthWindow({
  url: "http://example.corp/",
  completionUrlPatterns: ["api.example.corp/portal/main", "example.corp"],
  cookieHosts: ["sso.example.corp", "api.example.corp", "example.corp"],
  timeoutMs: 300_000,
  windowTitle: "포털 로그인",
});

// 반환된 쿠키로 직접 HTTP 요청
const jar = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const res = await fetch("https://api.example.corp/api/...", { headers: { Cookie: jar },
});
```

- Electron 내장 Chromium `BrowserWindow` + `session.cookies` API 사용 — **Selenium/webdriver 의존 제거**.
- 사용자가 창 안에서 SSO 로그인 수행 → `completionUrlPatterns` 중 하나와 매칭되는 URL로 navigate되면 쿠키 수집 후 창 자동 close.
- `cookieHosts`는 **도메인 suffix 매칭** (선행 점 정규화) — `evil-example.corp`이 `example.corp`에 매칭되지 않도록 엄격 비교.
- 타임아웃(기본 5분), 사용자 창 수동 close, `loadURL` 실패 모두 reject.
- `persistPartition`(예: `persist:corp-auth`)을 지정하면 영구 세션 격리 — 여러 포털 간 쿠키 교차 방지.
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
|----------------- |-------------------------------------------------------------------------------------------------------------------------- |---------------------------- |
| Host ↔ Renderer | Electron `ipcMain.handle()` (`lvis:settings:*`, `lvis:chat:*`, `lvis:memory:*`, `lvis:permissions:*`, `lvis:plugins:call`) | UI ↔ 메인 프로세스 |
| Marketplace | HTTPS REST (`/plugins/list`, `/plugins/download`) | 플러그인 카탈로그 + 다운로드 |
| Governance Server | HTTPS REST | 정책·감사 업로드 |
| MCP | stdio/HTTP (MCP 프로토콜) | 외부 MCP 서버와 통신 |

호스트는 이 계층에서만 IPC 채널 이름과 RPC 스키마를 정의한다. `RESERVED_HOST_CHANNELS` Set 이 플러그인의 채널 이름 충돌을 차단한다.

### 플러그인의 통신 경계

플러그인은 **tool 레벨만** 사용한다:

- **LLM → plugin tool**: `ToolRegistry` 경유. manifest `tools[]` 에 선언된 이름이 LLM 에 노출, 호출 시 `handlers[toolName]` 로 라우팅. IPC 채널 없음.
- **Renderer UI → plugin method**: 호스트가 제공하는 generic 핸들러 `lvis:plugins:call(toolName, payload)` 단 하나 경유. 각 tool 의 `_meta.ui.visibility` (app-visible) 로 gating (§2.2) — 이름 패턴 차단은 없으며, 확인 UX 는 플러그인이 자체 UI 로 구현한다. 플러그인이 채널을 직접 선언하지 않는다.
- **Plugin → host service**: `PluginHostApi` 메서드 직접 호출 (in-process).
- **Plugin → plugin**: 이벤트 버스(`hostApi.emitEvent` / `onEvent`)만 사용한다. 요청/응답이 필요하면 이벤트 payload에 `requestId`를 넣고 응답 이벤트를 정의한다. 직접 tool 호출, peer module import, handler 직접 호출은 불가하다. 각 플러그인의 자체 UI/MCP tool 호출은 기존의 소유자 검증·권한 경로를 그대로 따른다.

매니페스트에 IPC 바인딩 필드는 존재하지 않으며, 플러그인 번들에서도 Electron `ipcRenderer`/`ipcMain` 을 직접 사용하면 안 된다.

---

## 5. 번들 플러그인 케이스스터디

### 5.1 Meeting Recorder (`meeting`)

**파일:** `lvis-plugin-meeting/src/hostPlugin.ts`

**주요 handler:** `meeting_start` / `meeting_push_chunk` / `meeting_stop` / `meeting_transcript` / `meeting_sessions`.

- `capabilities: ["meeting-recorder"]` — `meeting.*` emit 게이트 통과.
- `meeting_transcript` / `meeting_sessions` 는 `_meta.ui.visibility: ["model","app"]` (겸용) 으로 렌더러에서도 호출 가능하다 — visibility 에 `"model"` 이 있어 host delegate 를 통해 ToolExecutor 권한 경로를 통과하고, app-only(`["app"]`) tool 은 active user activation gate 와 runtime visibility/audit path 를 통과한다.
- 각 tool 은 `inputSchema` 를 담으며, `meeting_push_chunk` 는 PCM `number[]` 추론 보조를 제공한다 (effective category 는 host 가 분류).
- `meeting_stop` 반환값이 크므로 LLM context 소비 주의 — 요약만 반환.

### 5.2 Local Indexer (`local-indexer`)

**파일:** `lvis-plugin-local-indexer/src/hostPlugin.ts:210-303`

- `capabilities: ["knowledge-index", "worker-client"]`.
- Python subprocess (30s 폴링) 로 FileWatcher 대신 운영 — `index_scan` 은 멱등 설계.
- `index_add_folder` 는 `/etc`, `/usr`, `~/.ssh` 등 위험 경로를 플러그인이 스스로 차단 — HostApi 레벨 제어 없음.
- 각 tool `inputSchema` 필수: `index_add_folder` 는 path 인자를 `_meta["lvisai/pathFields"]` 로 선언한다 (effective category 는 host 가 분류).

### 5.3 MS Graph (`ms-graph`)

**파일:** `lvis-plugin-ms-graph/src/hostPlugin.ts`

- `capabilities: ["mail-source", "calendar-source", "ms-graph-consumer"]`.
- 인증은 플러그인 자체 MSAL + safeStorage 경로가 소유한다. Host 는 provider-specific token HostApi 를 제공하지 않는다.
- 메일/캘린더 mutation tool 의 effective category(`write`/`network`)는 host 가 invocation 별로 분류하고, UI 호출이 필요하면 `_meta.ui.visibility` 에 `"app"` 을 추가한다.

### 5.4 Agent Hub (`agent-hub`)

**파일:** `lvis-plugin-agent-hub/src/hostPlugin.ts`

- `capabilities: ["host:overlay"]` — overlay staging 호출의 단일 런타임 게이트.
- 다른 플러그인에 대한 작업 요청과 결과 수신은 이벤트 요청/응답 계약으로 구현한다. 직접 tool 호출 권한은 제공하지 않는다.

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
|------------------------------------------------------------- |------------------------- |-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **worker_threads / process 격리** | ❌ 기각 | in-process + try/catch 로 95% 장애 커버. 격리 시 IPC 오버헤드 + 디버깅 복잡도 증가. |
| **marketplace artifact 검증** | ✅ **승인** | 플러그인 저자가 sidecar 서명을 만들지 않고 marketplace가 artifact envelope을 서명합니다. 호스트는 설치 시 envelope을 검증하고 로드 시 install receipt 해시를 확인합니다. §2.1. |
| **`permissions[]` 선언형 필드** | ⚠️ **부분 승인** | full permission 문자열 배열은 기각되었지만, 다음 3종의 선언형 게이트가 대체 도입됨: (1) renderer→plugin allowlist (당시 `uiActions` map; #885 Phase R 이후 각 tool 의 `_meta.ui.visibility` — 파괴적 도구의 확인 UX 는 플러그인이 책임), (2) `capabilities[]` — `ms-graph-consumer` HostApi gate + event-emit namespace gate, (3) `PLUGIN_PRIVATE_NAMESPACES` — subscription deny-list. §2.2, §2.3. |
| **LLM invoke HostApi 추상화 (full surface)** | ❌ 기각 (callLlm 만 채택) | 단발 텍스트 생성 `callLlm()` 만 Phase 1에서 채택 (§4). streaming·tool_choice·thinking·multi-turn 등 vendor 편차 큰 surface 는 여전히 기각. |
| **파일 watcher HostApi (`watchFiles`)** | ❌ 기각 | local-indexer 1개 플러그인만 필요. "3+ 플러그인 규칙" 미충족. |
| **zod 자동 schema 추출** | ❌ 기각 | 번들 크기 증가, zod 버전 충돌. 수기 작성이 LLM 최적화 면에서도 우수. |
| **tool `outputSchema` (Phase 1)** | ❌ 기각 | 응답은 LLM 이 string 으로 재소비 가능. Phase 2 에서 재검토. |
| **Full capability grant system** | ❌ 기각 | 현행 capability taxonomy (§2.3) + HostApi boundary 로 충분. |
| **Hot reload (Phase 1)** | ❌ 기각 | 개발 편의 기능. GA 블로커 아님. |
| **`triggerConversation` HostApi + `host:overlay` capability** | ✅ **승인** | §6.1 예외 #2 — plugin-authored prompt 를 사용자 입력 없이 host overlay 에 staged 하므로 audit / source-aware permission / capability gate / per-plugin rate limit (60s/6) / dedupe / source-pattern + length cap / prompt-length cap 같은 통제가 필수. 단일 consumer 라도 host 에 둠 (plugin-side 재구현 시 통제 일관성 X). 런타임 권한은 `host:overlay` 단일 capability 가 부여한다. 안전 계약 / spec / gate 는 [`overlay-trigger.md`](./overlay-trigger.md). |

---

## 7. Tool 명명 / Deployment

### 명명 규칙

- **LLM tool name**: `^[a-zA-Z_][a-zA-Z0-9_]*$` — underscore 형식. `tools[]` 에 직접 선언.
- **플러그인 ID**: `^[a-zA-Z][a-zA-Z0-9._-]*$` (3~128자). flat form 권장, dot form 허용.
- **이벤트 채널**: dot 형식 (`meeting.started`, `email.action.needed`). capability 게이팅 대상 (§2.3).
- 런타임 변환 없음 — manifest 에 선언한 이름이 그대로 Tool Registry 에 등록됨.

### Deployment 모드

| 항목 | `managed` | `user` |
|--------- |------------------------------------------------------- |------------------------------------------------------- |
| 설치 주체 | 회사 IT Admin / marketplace admin review | 사용자 marketplace publish |
| 삭제 권한 | 회사만 (`PluginDeploymentGuard.canUninstall()` = false) | 사용자 자유 |
| 업데이트 | 정책 push 시 강제 | 사용자 opt-in |
| 저장 경로 | `~/.lvis/plugins/installed/<id>/` | `~/.lvis/plugins/installed/<id>/` |
| 검증 | marketplace envelope + install receipt 해시 fail-closed | marketplace envelope + install receipt 해시 fail-closed |

상세 설계: `docs/architecture/plugin-deployment-model.md`

### 현행 코드 참조

| 역할 | 파일 |
|------------------------------------------------ |------------------------------------------------------------ |
| `PluginManifest` 타입 | `src/plugins/types.ts` |
| `PluginHostApi` 인터페이스 | `src/plugins/types.ts` |
| 플러그인 런타임 (로딩·주입·AJV·설치 영수증 검증) | `src/plugins/runtime.ts` |
| Manifest JSON Schema | `@lvis/plugin-sdk/schemas/plugin-manifest.schema.json` |
| Capability taxonomy | `src/plugins/capabilities.ts` |
| Marketplace artifact verifier | `src/plugins/envelope-verifier.ts` |
| Marketplace keys (host-owned) | `src/plugins/marketplace-keys.ts` |
| Install receipt integrity | `src/plugins/plugin-install-receipt.ts` |
| Deployment 가드 | `src/plugins/deployment-guard.ts` |
| callLlm rate-limit | `src/boot/conversation.ts` (`createCallLlmForPlugin`) |
| 등록 진입점 | `src/boot.ts` |
| 플러그인 배포 | Marketplace artifact install 경로 (`src/plugins/runtime.ts`) |

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
  "tools": [
    {
      "name": "my_action",
      "description": "입력 문자열을 대문자로 변환한다.",
      "inputSchema": {
        "type": "object",
        "required": ["input"],
        "properties": {
          "input": { "type": "string" }
        }
      },
      "_meta": { "ui": { "visibility": ["model"] } }
    }
  ],
  "installPolicy": "user"
}
```

### 첫 메서드까지 체크리스트

- [ ] `tools[]` 이름과 `handlers` 키가 정확히 일치
- [ ] 모든 handler 가 `payload?: unknown` 을 타입 캐스팅 후 사용
- [ ] 필수 파라미터 누락 시 `throw new Error()` 로 명확한 에러 메시지
- [ ] `dist/index.js` 가 `RuntimePluginFactory` 를 default export
- [ ] `plugin.json` 의 `entry` 가 실제 빌드 산출물 경로
- [ ] 각 `tools[]` Tool 객체에 `description` (10자 이상), `inputSchema`, `_meta.ui.visibility`, 필요 시 `_meta["lvisai/pathFields"]`
- [ ] marketplace publish/upload 경로로 artifact를 게시

### @lvis/plugin-sdk (현행)

호스트와 활성 플러그인 (`meeting` / `local-indexer` / `ms-graph` / `corp-portal` / `work-assistant` / `agent-hub`) 은 released git tag 로 고정한 `@lvis/plugin-sdk` 를 사용한다. 호스트는 SDK 패키지의 `schemas/plugin-manifest.schema.json` 을 런타임에 resolve 하며, app-local schema extension 이나 플러그인별 path alias 를 두지 않는다. SDK 태그는 manifest schema, 공개 타입, `host:overlay` capability enum 의 단일 배포 단위다.

```jsonc
// package.json
{
  "dependencies": {
    "@lvis/plugin-sdk": "github:lvis-project/lvis-plugin-sdk#v5.0.3",
  },
}
```
