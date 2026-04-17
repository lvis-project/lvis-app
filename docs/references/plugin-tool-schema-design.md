# Plugin Tool Schema Design — LVIS

**Status:** Draft v1.3  
**Prepared:** 2026-04-17  
**Updated:** 2026-04-18 — MCP 버전 정정, openWorldHint 추가, command/background outputSchema 추가, subagent.historyPolicy 추가; 2026-04-18 — ULTRATHINK 레퍼런스 분석 기반 구조 조정 (격리모드, Capability권한, 스케줄실행, 개발방향); 2026-04-18 — background executionType 제거: fire-and-forget은 subagent.allowBackground + runInBackground 파라미터로, cron은 manifest.schedule[]로 분리  
**Scope:** Plugin-side tool schema declaration, dynamic loading, execution type routing, sub-agent support

---

## TL;DR

현재 `plugin.json`의 `methods: string[]` + 단일 `payload: object` 스키마는 LLM이 파라미터를 추론할 수 없다. 플러그인이 `tools[]` 배열로 per-method 스키마를 직접 선언하도록 개선한다. `executionType` 필드로 동기 명령(`command`)과 서브에이전트(`subagent`)를 구분한다. fire-and-forget 비동기 실행은 `subagent.allowBackground: true` + LLM이 툴 호출 시 `runInBackground: true` 파라미터를 전달하는 방식으로 처리하며, cron 스케줄 실행은 `PluginManifest.schedule[]` 블록으로 선언한다(툴 executionType과 무관). 기존 `methods[]` 기반 플러그인은 그대로 동작(fallback).

---

## 1. 상용 표준 조사 요약

### 1.1 LLM 툴 호출 스키마 비교

| 필드 | OpenAI | Anthropic | Gemini | MCP 2025-06-18 |
|------|--------|-----------|--------|----------------|
| 식별자 | `function.name` | `name` | `name` | `name` |
| 설명 | `function.description` | `description` | `description` | `description` |
| 제목 | ❌ | ❌ | ❌ | ✅ `title` (신규) |
| 입력 스키마 | `function.parameters` (JSONSchema) | `input_schema` (JSONSchema) | `parameters` (OpenAPI subset) | `inputSchema` (JSONSchema 2020-12) |
| 출력 스키마 | ❌ | ❌ | ❌ | ✅ `outputSchema` |
| 예시 | ❌ | ✅ `input_examples` | ❌ | ❌ |
| 동작 힌트 | ❌ | ❌ | ❌ | ✅ `annotations.*` (readOnly/destructive/idempotent/**openWorld**) |
| 실행 모드 | request-level | ❌ | request-level | ✅ `execution.taskSupport` |
| 이름 규칙 | `[a-zA-Z0-9_-]{1,64}` | 동일 | 공백/특수문자 불가 | `[A-Za-z0-9_\-.]{1,128}` |

### 1.2 핵심 발견

1. **`executionType` 표준 없음** — 벤더마다 다른 방식으로 처리. MCP 2025-06-18의 `execution.taskSupport`가 per-tool 실행 모드 선언에 가장 근접한 표준.
2. **`outputSchema`는 MCP만** — 다른 프로바이더는 출력 타입 선언 없음. LVIS가 MCP를 기반으로 하므로 이를 채택.
3. **설명 품질이 가장 중요** — Anthropic 자체 연구: 스키마 정밀도보다 description 작성 품질이 LLM 호출 정확도에 더 큰 영향.
4. **MCP가 사실상 표준** — LVIS가 이미 MCP 사용 중. `x-lvis` 벤더 확장 prefix로 MCP 호환성 유지.

### 1.3 유용한 패턴

| 패턴 | 출처 | LVIS 적용 |
|------|------|----------|
| `annotations.destructiveHint/readOnlyHint/openWorldHint` | MCP 2025-06-18 | AgentApproval 시스템(§8)과 연동 |
| `activationEvents` 지연 로드 | VSCode | `keywords[]`/KeywordEngine 트리거 매핑 |
| `description_for_model` vs `_for_human` | ChatGPT Plugins | `description` vs `uiTitle` 분리 |
| `return_direct=True` | LangChain | `subagent.allowBackground` + `runInBackground` 파라미터 패턴 |
| 서브에이전트 Handoff + `input_filter` | OpenAI Agents SDK | `executionType: "subagent"` + `historyPolicy` |

### 1.4 상용 Chat CLI 비교 (2026-04-18 조사)

> 출처: MCP 2025-06-18 공식 스펙, Claude Code Hooks 문서, OpenAI Agents SDK, Continue.dev config.yaml, Cursor MCP 문서, VS Code Agent Plugins (Preview)

| 항목 | MCP 2025-06-18 | Claude Code | OpenAI Agents SDK | Cursor | Continue.dev | GitHub Copilot / VS Code | **LVIS** |
|------|---------------|-------------|-------------------|--------|-------------|--------------------------|---------|
| **Tool 선언** | `name/title/description/inputSchema/outputSchema/annotations` | 이름 매칭; `mcp__<server>__<tool>` 패턴 | `@function_tool` 데코레이터 자동 추출 or `FunctionTool` 명시 | MCP passthrough (`.cursor/mcp.json`) | `mcpServers` in config.yaml | `plugin.json` (`agents/skills/mcpServers`) | `plugin.json` `tools[]` — MCP 호환 + `executionType` 확장 |
| **서브에이전트** | ❌ (transport 전용) | `.claude/agents/*.md` + `Agent` tool | `Agent.as_tool()` + `handoff(input_filter)` | ❌ | ❌ | `.github/agents/*.agent.md` | ✅ `executionType:"subagent"` — **유일하게 tool 선언 레벨에서 명시** |
| **백그라운드/비동기** | ❌ 동기 전용 | `async:true` + `asyncRewake` (hook 레이어) | Python async 네이티브 (schema 없음) | ❌ | ❌ | ❌ | ✅ `subagent.allowBackground:true` + LLM `runInBackground` 파라미터; cron은 `manifest.schedule[]` 블록 |
| **슬래시 커맨드** | ❌ 스펙 외 | `/hooks` 브라우저 (읽기 전용) | ❌ | ❌ | `prompts[]` (deprecated) | 마켓플레이스 번들 | plugin.json 별도 처리 |
| **권한/승인** | SHOULD 권고 (primitives 없음) | 풍부: `PreToolUse` allow/deny/ask/defer, rule scoping, mode switching | `needs_approval` + `result.interruptions` | ❌ | 최소 제한 원칙 | hook lifecycle | `annotations` → `PermissionManager` → `AgentApproval` gate |
| **Output Schema** | ✅ tool 선언 레벨 | N/A | `output_schema` (agent-tool 레벨) | MCP passthrough | MCP passthrough | MCP passthrough | ✅ tool 레벨 `outputSchema` + `subagent.resultSchema` |

#### LVIS가 모든 시스템 대비 우위인 부분

1. **`executionType` 선언**: 실행 모드를 tool 메타데이터로 선언. 다른 시스템은 코드/런타임에서 암묵적으로 결정.
2. **비동기 실행 선언**: `subagent.allowBackground:true` + LLM이 `runInBackground` 파라미터로 결정. cron 스케줄은 `manifest.schedule[]` 블록으로 분리 선언. MCP는 동기만, Claude Code asyncRewake는 hook 레이어.
3. **서브에이전트 선언형 설정**: systemPrompt + allowedTools + resultSchema + historyPolicy + allowBackground를 tool 정의에서 자체 선언. OpenAI SDK는 orchestration 코드에서 처리.

#### 다른 시스템 대비 LVIS 갭 (개선 여지)

| 갭 | 참조 시스템 | 비고 |
|----|-----------|------|
| `subagent.historyPolicy` 미구현 | OpenAI `input_filter` | v1.1에서 스펙 추가 완료, 구현 필요 |
| 병렬 서브에이전트 | LangGraph parallel edges | 현재 depth 2 순차만 |
| 스트리밍 중간 결과 | OpenAI streaming tool output | subagent 이벤트 스트림으로 부분 대체 가능 |
| Permission primitives in schema | Claude Code PreToolUse | annotations → PermissionManager 연동으로 간접 처리 |

### 1.5 레퍼런스 구현 분석 (claw-code / OpenHarness / Paperclip)

> 조사 일자: 2026-04-18. 소스: GitHub 공식 리포 + 문서.

#### claw-code / OpenClaw

**GitHub:** `ultraworkers/claw-code` (Claude Code 기반 Rust 플러그인 레이어)

| 항목 | 내용 |
|------|------|
| Tool 선언 | YAML/JSON + Serde(Rust) 타입 안전 파싱. `name`, `parameters`, `return type` + LLM API 전달용 메타데이터 |
| Plugin 로딩 | 플러그인당 tools, skills(markdown), channels, model providers, voice, transcription 등록 — 조합 자유 |
| SubAgent | `sessions_*`, `subagents`, `agents_list` 툴로 멀티세션 에이전트 위임 |
| 슬래시 커맨드 | `session_status` 툴 경유 `/status`-style 커맨드; 세션별 모델 오버라이드 |
| Background | `cron` 툴(스케줄 작업) + `process` 툴(백그라운드 프로세스 라이프사이클) — LVIS는 `manifest.schedule[]` 블록으로 cron 수용 |
| Permission | allow/deny 목록; tool profile(`full`, `code-only` 등) |

**LVIS 대비 차별점**: Rust 타입 시스템으로 스키마 검증 — ajv 대신 컴파일 타임 보장. `process` 툴이 백그라운드 프로세스 레벨 제어(LVIS는 이벤트 기반).

---

#### OpenHarness

**성격**: Node.js/TypeScript 멀티에이전트 오케스트레이션 하네스. Claude Code 위에서 동작.

| 항목 | 내용 |
|------|------|
| Tool 선언 | Pydantic BaseModel 자동 스키마 추출; 타입 어노테이션 → JSONSchema 변환 |
| Plugin 로딩 | 설정 파일 기반; 12개 공식 플러그인 포함 (commit, security, multi-agent review 등) |
| SubAgent | `Agent` 툴로 위임; `TeamCreate/Delete` 팀 레지스트리; ClawTeam 연동 로드맵 |
| 슬래시 커맨드 | React TUI 54+ 커맨드 (`/help`, `/commit`, `/plan`, `/resume`, `/permissions` 등); 자동완성 picker |
| Background | `TaskCreate/Get/List/Update/Stop/Output` 라이프사이클; `CronCreate/List/Delete`; RemoteTrigger |
| Permission | PreToolUse allow/deny/ask/defer; `PermissionRequest`/`PermissionDenied`; mode switching |

**LVIS 대비 차별점**: 슬래시 커맨드 자동완성 TUI가 가장 완성됨. `CronCreate` 스케줄 실행이 LVIS `manifest.schedule[]`보다 정교 (취소/조회 API 포함).

---

#### Paperclip (`paperclipai/paperclip`)

**성격**: "zero-human company" 지향 멀티에이전트 플랫폼 (2026-03 출시, Node.js/React).

| 항목 | 내용 |
|------|------|
| Tool 선언 | `ctx.tools.register()` in plugin worker. Manifest: `PaperclipPluginManifestV1` — `id`, `version`, `capabilities[]`, UI slot definitions, tool specs |
| Plugin 로딩 | **플러그인당 독립 프로세스** (Node.js child process). stdin/stdout JSON-RPC 2.0. Dynamic ESM import. **Hot reload** (install/uninstall/upgrade 재시작 없음) |
| SubAgent | `ServerAdapterModule` 인터페이스 — `execute`, `listSkills`, `syncSkills`, `sessionCodec`. Claude/Codex/Gemini/OpenClaw 어댑터 레지스트리 (`server/src/adapters/registry.ts`) |
| 슬래시 커맨드 | 플러그인 스펙 미문서화 |
| Background | 플러그인 worker 기여 cron/job hooks |
| Permission | manifest capabilities 선언 (`issues.read`, `http.outbound` 등). **호스트 RPC 레이어 강제** — 범위 초과 호출 거부. core governance(승인 gate, 예산 hard-stop)는 플러그인이 오버라이드 불가 |

> ⚠️ `PLUGIN_SPEC.md`는 "proposed / post-V1" 상태 — 현재 구현체는 early runtime.

**LVIS 대비 차별점**:
- **프로세스 격리**: 플러그인 크래시가 호스트에 영향 없음 (LVIS는 in-process)
- **Hot reload**: 재시작 없이 플러그인 교체 (LVIS 미지원)
- **Capability-based permission**: manifest에서 세밀한 권한 선언 → LVIS `permissions[]` 필드와 유사하나 RPC 레이어 강제가 더 견고

---

#### 세 레퍼런스에서 LVIS가 채택할 수 있는 패턴

| 패턴 | 출처 | LVIS 적용 가능성 |
|------|------|----------------|
| 플러그인 프로세스 격리 | Paperclip | P4 — 장기 안정성 향상, 구현 비용 큼 |
| Hot reload (재시작 없는 교체) | Paperclip | P3 — marketplace install 시 유용 |
| `process` 툴 (OS 프로세스 제어) | claw-code | P3 — meeting-recorder 등 native 프로세스 필요 플러그인에 유용 |
| Cron 스케줄 실행 | OpenHarness | P2 — `manifest.schedule[]` 블록으로 수용 (executionType과 분리) |
| Capability-based RPC 강제 | Paperclip | P2 — `permissions[]` → PermissionManager 연동 강화 |

---

## 2. 설계 결정

### 핵심 원칙

- **플러그인 자유도 최대화**: 최소 필수 필드만 강제 (`name`, `description`, `executionType`)
- **하위 호환**: 기존 `methods: string[]`은 generic payload fallback으로 계속 동작
- **LLM 최적화**: description + 예시로 LLM이 언제/어떻게 호출할지 이해할 수 있게
- **MCP 호환**: 표준 필드 우선, LVIS 고유 필드는 `x-lvis` prefix

### 아키텍처 결정 (v1.1 — 레퍼런스 분석 기반)

#### 결정 1: Capability 기반 권한 강제 (Paperclip RPC 레이어 참조)
현재: `permissions[]`는 string 배열이나 런타임 강제 없음.
결정: `PermissionManager`가 `permissions[]`를 파싱하여 HostApi 호출 시 RPC 레이어에서 강제.
Scope 형식: `audio.capture`, `fs.read:~/.lvis`, `fs.write:~/.lvis/meetings`, `http.outbound:api.openai.com`, `llm.invoke`, `ipc.emit`, `ipc.subscribe`.
오버스코프 호출 → 즉시 PermissionDenied (플러그인이 오버라이드 불가).
**근거**: Paperclip의 "core governance는 플러그인이 오버라이드 불가" 원칙. AgentApproval §8과 연동.

#### 결정 3: Background 스케줄 실행 (OpenHarness CronCreate 패턴 참조)
현재: 플러그인이 자체 setInterval로 폴링 (pageindex 30s 폴링 known issue).
결정: `PluginManifest`에 `schedule?: PluginScheduleSpec[]` 블록 추가. 호스트가 스케줄 실행을 담당. `executionType`과 완전히 분리 — `"command"` 또는 `"subagent"` 타입 툴 모두 스케줄 등록 가능.
플러그인이 폴링 로직을 직접 구현할 필요 없음 → TODO.md의 "30s polling" 이슈 해소 경로.
**근거**: OpenHarness의 CronCreate/List/Delete 패턴을 plugin.json 선언으로 내면화. `executionType:"background"` 종속성을 제거해 스케줄과 실행 모드를 독립적으로 선언 가능.

---

## 3. 확장된 `plugin.json` 스키마

### 3.1 전체 구조

```jsonc
{
  // === 기존 필드 (하위 호환 유지) ===
  "id": "com.lge.meeting-recorder",
  "name": "Meeting Recorder",
  "version": "1.2.0",
  "entry": "dist/index.js",
  "methods": ["meeting_start", "meeting_stop", "meeting_summarize"],  // 레거시 seed

  // === 신규: per-method 스키마 선언 ===
  "tools": [
    {
      // --- 필수 ---
      "name": "meeting_start",
      "description": "현재 활성 회의의 녹음을 시작합니다. 시스템 오디오와 마이크(권한 허용 시)를 캡처합니다. 반환된 sessionId는 meeting_stop, meeting_summarize에서 사용됩니다. 회의가 이미 진행 중인 경우에는 사용하지 마세요.",
      "executionType": "command",

      // --- 선택: MCP 2025-06-18 호환 ---
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "title":      { "type": "string", "description": "회의 제목" },
          "language":   { "type": "string", "enum": ["ko", "en", "auto"], "default": "auto" },
          "captureMic": { "type": "boolean", "default": true }
        },
        "required": ["title"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "sessionId": { "type": "string" },
          "startedAt": { "type": "string", "format": "date-time" }
        },
        "required": ["sessionId", "startedAt"]
      },
      "outputDescription": "{sessionId, startedAt}을 반환합니다. sessionId는 meeting_stop, meeting_summarize에 필요합니다.",
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false
      },

      // --- 선택: LLM 호출 품질 향상 ---
      "examples": [
        {
          "description": "한국어/영어 자동감지 회의 시작",
          "input": { "title": "주간 제품 리뷰" },
          "output": { "sessionId": "mtg_01HXYZ", "startedAt": "2026-04-17T10:00:00Z" }
        }
      ],

      // --- 선택: 권한 및 메타데이터 ---
      "permissions": ["audio.capture", "fs.write:~/.lvis/meetings"],
      "tags": ["meeting", "recording"],
      "timeoutMs": 5000,
      "uiTitle": "회의 녹음 시작"
    },

    // === 서브에이전트 타입 ===
    {
      "name": "meeting_summarize",
      "description": "완료된 회의 트랜스크립트를 분석하여 결정사항, 액션아이템, 리스크를 구조화된 요약으로 생성합니다. 내부적으로 LLM 서브에이전트를 사용합니다. 회의가 종료된 후 사용하세요.",
      "executionType": "subagent",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": { "type": "string" },
          "style": { "type": "string", "enum": ["bullet", "narrative"], "default": "bullet" }
        },
        "required": ["sessionId"]
      },
      "subagent": {
        "systemPrompt": "당신은 회의 분석 전문가입니다. 트랜스크립트를 분석하여 {decisions, actions, risks}를 JSON으로 반환하세요. 사실에 근거하여 작성하고 추측하지 마세요.",
        "allowedTools": ["meeting_get_chunk", "meeting_list_chunks"],
        "maxTurns": 8,
        "model": "inherit",
        "resultSchema": {
          "type": "object",
          "properties": {
            "decisions": { "type": "array", "items": { "type": "string" } },
            "actions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "owner": { "type": "string" },
                  "task": { "type": "string" },
                  "due": { "type": "string" }
                }
              }
            },
            "risks": { "type": "array", "items": { "type": "string" } }
          }
        }
      },
      "annotations": { "readOnlyHint": true },
      "permissions": ["llm.invoke"]
    },

    // === 비동기 서브에이전트 타입 (fire-and-forget) ===
    {
      "name": "meeting_export_video",
      "description": "회의 녹화를 MP4로 내보내기 시작합니다. 완료까지 수분이 소요됩니다. LLM이 runInBackground:true로 호출하면 taskId를 즉시 반환합니다. 결과를 기다리지 마세요.",
      "executionType": "subagent",
      "inputSchema": {
        "type": "object",
        "properties": {
          "sessionId": { "type": "string" },
          "quality": { "type": "string", "enum": ["720p", "1080p"], "default": "1080p" },
          "runInBackground": { "type": "boolean", "description": "true이면 즉시 taskId 반환 (Claude Code Agent.run_in_background 패턴)", "default": true }
        },
        "required": ["sessionId"]
      },
      "subagent": {
        "systemPrompt": "회의 녹화를 MP4로 변환하고 완료 이벤트를 발행하세요.",
        "allowedTools": ["meeting_get_chunk"],
        "allowBackground": true,
        "maxTurns": 20
      },
      "annotations": { "readOnlyHint": false, "destructiveHint": false },
      "permissions": ["fs.write:~/.lvis/exports"]
    }
  ],

  // === 스케줄 선언 (executionType과 무관한 manifest 블록) ===
  "schedule": [
    {
      "cron": "0 */6 * * *",
      "method": "meeting_cleanup_old",
      "description": "6시간마다 오래된 임시 내보내기 파일 정리",
      "maxConcurrent": 1
    }
  ]
}
```

### 3.2 필드 참조

#### PluginToolDefinition

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `name` | string | ✅ | 안정적 식별자 `[a-zA-Z_][a-zA-Z0-9_]*` max 64 |
| `description` | string | ✅ | LLM용. 언제/무엇을/무엇을 반환/언제 쓰지 말아야 하는지 포함 |
| `executionType` | enum | ✅ | `"command"` \| `"subagent"` |
| `inputSchema` | JSONSchema | ❌ | 없으면 `{payload: object}` fallback |
| `outputSchema` | JSONSchema | ❌ | MCP 2025-06-18 호환. `command`/`subagent` 모두 적용. `subagent`는 `subagent.resultSchema`로도 검증 가능 (중복 시 `resultSchema` 우선) |
| `outputDescription` | string | ❌ | 반환값 설명 (description에 자동 포함) |
| `annotations` | object | ❌ | MCP 2025-06-18: readOnlyHint, destructiveHint, idempotentHint |
| `examples` | array | ❌ | input/output 예시 (description에 자동 포함) |
| `permissions` | string[] | ❌ | `PermissionManager` 게이팅용 |
| `tags` | string[] | ❌ | 검색/분류용 |
| `timeoutMs` | integer | ❌ | 기본 30000 |
| `uiTitle` | string | ❌ | 사람용 표시명 (UI 슬롯용) |
| `subagent` | SubagentSpec | `executionType="subagent"` 시 필수 | 서브에이전트 설정 (`allowBackground` 포함) |

#### SubagentSpec

| 필드 | 타입 | 설명 |
|------|------|------|
| `systemPrompt` | string | 서브에이전트 시스템 프롬프트 |
| `allowedTools` | string[] | 서브에이전트가 호출 가능한 툴 이름 목록 |
| `maxTurns` | integer | 최대 턴 수 (기본 8, 최대 50) |
| `model` | string | `"inherit"` (기본) 또는 모델 ID |
| `resultSchema` | JSONSchema | 최종 출력 검증용 스키마 |
| `historyPolicy` | enum | 부모 대화 히스토리 전달 방식: `"none"` (기본, userMessage만) \| `"summary"` \| `"full"` (OpenAI input_filter 패턴) |
| `allowBackground` | boolean | `true`이면 LLM이 `runInBackground:true` 파라미터로 호출 시 taskId를 즉시 반환 (Claude Code Agent.run_in_background 패턴). 기본 `false` |

#### PluginScheduleSpec (PluginManifest.schedule[] 항목)

cron 스케줄 실행은 `executionType`과 무관하게 `manifest.schedule[]`로 선언한다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `cron` | string | cron 표현식 (`"0 */6 * * *"` 등). 호스트가 스케줄 관리 |
| `method` | string | 실행할 tool name (`methods[]`에 선언된 이름) |
| `description` | string | 스케줄 설명 (선택) |
| `maxConcurrent` | integer | 동시 실행 최대 인스턴스 수 (기본 1). 스케줄 실행 시 중복 방지 |

---

## 4. TypeScript 인터페이스

`src/plugins/types.ts`에 추가:

```typescript
export type ToolExecutionType = "command" | "subagent";

export interface PluginToolAnnotations {
  readOnlyHint?: boolean;      // 읽기 전용 (AgentApproval auto-approve 가능)
  destructiveHint?: boolean;   // 파괴적 작업 (강화된 승인 필요)
  idempotentHint?: boolean;    // 멱등성 (재시도 안전)
  openWorldHint?: boolean;     // MCP 2025-06-18: 선언된 범위 밖 외부 시스템 접촉 가능 여부
}

export interface PluginToolExample {
  description?: string;
  input: unknown;
  output?: unknown;
}

export interface PluginSubagentSpec {
  systemPrompt: string;
  allowedTools?: string[];
  maxTurns?: number;        // default 8
  model?: string;           // default "inherit"
  resultSchema?: object;
  historyPolicy?: "none" | "summary" | "full";  // default "none"; ref: OpenAI input_filter
  summaryCutoff?: number;   // max chars when historyPolicy="summary"; default 2000
  allowBackground?: boolean; // default false; LLM이 runInBackground:true 전달 시 taskId 즉시 반환 (Claude Code Agent.run_in_background 패턴)
}

export interface PluginScheduleSpec {
  cron: string;             // cron expression (e.g. "0 */6 * * *"); host manages scheduling
  method: string;           // tool name to invoke (must be in methods[])
  description?: string;
  maxConcurrent?: number;   // default 1; prevents duplicate concurrent runs
}

export interface PluginToolDefinition {
  name: string;
  description: string;
  executionType: ToolExecutionType;
  inputSchema?: object;
  outputSchema?: object;
  outputDescription?: string;
  annotations?: PluginToolAnnotations;
  examples?: PluginToolExample[];
  permissions?: string[];
  tags?: string[];
  timeoutMs?: number;
  uiTitle?: string;
  subagent?: PluginSubagentSpec;   // executionType="subagent" 시 필수
}

// 기존 PluginManifest에 추가
// tools?: PluginToolDefinition[];
// schedule?: PluginScheduleSpec[];  // cron 스케줄 선언 (executionType과 무관)

export type CapabilityScope =
  | `audio.${"capture" | "playback"}`
  | `fs.${"read" | "write"}:${string}`
  | `http.outbound:${string}`
  | "llm.invoke"
  | "llm.embed"
  | "ipc.emit"
  | "ipc.subscribe";
// permissions[] 는 CapabilityScope[] 로 타입 강화 (하위 호환: string[]도 수용)

// PluginHostApi에 추가
export interface SpawnSubagentRequest {
  systemPrompt: string;
  userMessage: string;
  allowedTools: string[];
  maxTurns?: number;
  model?: string;
  resultSchema?: object;
  parentRequestId?: string;
}

export interface SpawnSubagentResult {
  output: string;
  toolCalls: number;
  stoppedBy: "complete" | "maxTurns" | "error";
  isError?: boolean;
}
// hostApi.spawnSubagent(req: SpawnSubagentRequest): Promise<SpawnSubagentResult>
```

---

## 5. 호스트 로딩 로직

### 5.1 Tool 등록 흐름

```
plugin.json 로드
  ↓
tools[] 파싱 (없으면 methods[]에서 legacy seed 생성)
  ↓
per-tool: executionType으로 분기
  ├─ "command"    → buildCommandTool(runtime, def)
  └─ "subagent"   → buildSubagentTool(hostApi, def)
                     (allowBackground:true이면 runInBackground 파라미터 지원)
  ↓
description 합성 (description + outputDescription + examples)
  ↓
ToolRegistry.register(tool)
  ↓
LLM에 전달 (Anthropic: input_schema / OpenAI: parameters)
```

### 5.2 Description 합성 규칙

LLM에 전달되는 최종 description:

```
<def.description>

Output: <def.outputDescription>
Examples:
  - <example.description>: input=<JSON>, output=<JSON>
[subagent.allowBackground=true: 비동기 실행 가능 — LLM이 runInBackground:true 전달 시 taskId 즉시 반환]
```

### 5.3 하위 호환 Fallback

```typescript
// tools[]가 없거나 특정 메서드가 tools에 없는 경우
if (!declared.has(methodName)) {
  declared.set(methodName, {
    name: methodName,
    description: `플러그인 메서드: ${methodName}. payload에 필요한 매개변수를 JSON 객체로 전달하세요.`,
    executionType: "command",
    inputSchema: {
      type: "object",
      properties: { payload: { type: "object" } }
    },
  });
}
```

---

## 6. 서브에이전트 실행 흐름

```
LLM → tool_use { name: "meeting_summarize", input: {sessionId, style} }
  ↓
buildSubagentTool.execute()
  ↓
hostApi.spawnSubagent({
  systemPrompt: def.subagent.systemPrompt,
  userMessage: `Summarize sessionId=${input.sessionId} in ${input.style} style`,
  allowedTools: def.subagent.allowedTools,   // ["meeting_get_chunk", ...]
  maxTurns: def.subagent.maxTurns,
  resultSchema: def.subagent.resultSchema,
  parentRequestId: currentRequestId,
})
  ↓
Host: 새 ConversationLoop 생성
  - 동일 provider 재사용
  - ToolRegistry.createScopedView(allowedTools) — 허용된 툴만 노출
  - depth counter 확인 (최대 depth 2)
  - AbortSignal 부모와 공유
  ↓
서브에이전트 실행 (maxTurns까지)
  ↓
resultSchema 검증 (ajv)
  ↓
ToolResult { output: finalText, isError: false }
  ↓
부모 ConversationLoop에 tool_result로 반환
```

**깊이 제한**: 기본 최대 depth 2. 서브에이전트가 또 다른 `subagent` 타입 툴을 호출하면 `depth exceeded` 오류.

---

## 7. LLM 전달 형식

### Anthropic 형식 (`meeting_start` 예시)

```json
{
  "name": "meeting_start",
  "description": "현재 활성 회의의 녹음을 시작합니다...\n\nOutput: {sessionId, startedAt}을 반환합니다...\nExamples:\n  - 한국어/영어 자동감지 회의 시작: input={\"title\":\"주간 제품 리뷰\"}, output={\"sessionId\":\"mtg_01HXYZ\",...}",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "title":      { "type": "string", "description": "회의 제목" },
      "language":   { "type": "string", "enum": ["ko", "en", "auto"], "default": "auto" },
      "captureMic": { "type": "boolean", "default": true }
    },
    "required": ["title"]
  }
}
```

### OpenAI 형식 (provider가 자동 변환)

```json
{
  "type": "function",
  "function": {
    "name": "meeting_start",
    "description": "...(동일)...",
    "parameters": { /* 동일 JSONSchema */ },
    "strict": true
  }
}
```

**이중 형식 변환은 무료**: plugin이 JSONSchema 한 번 선언 → 각 provider adapter가 자동 변환.

---

## 8. AgentApproval 시스템 연동

`annotations` 필드를 `PermissionManager`와 연동:

| `annotations` 조합 | 승인 정책 |
|-------------------|----------|
| `readOnlyHint: true` | 자동 승인 |
| `destructiveHint: true, idempotentHint: false` | 명시적 사용자 승인 필수 |
| `destructiveHint: true, idempotentHint: true` | 경고 표시 + 자동 승인 |
| 기본 (힌트 없음) | 기존 정책 유지 |

---

## 9. JSON Schema 검증 추가 (`schemas/plugin.schema.json`)

```jsonc
// plugin.schema.json에 추가
"tools": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["name", "description", "executionType"],
    "additionalProperties": false,
    "properties": {
      "name": { "type": "string", "pattern": "^[a-zA-Z_][a-zA-Z0-9_]*$", "maxLength": 64 },
      "description": { "type": "string", "minLength": 10, "maxLength": 2048 },
      "executionType": { "enum": ["command", "subagent"] },
      "inputSchema": { "type": "object" },
      "outputSchema": { "type": "object" },
      "outputDescription": { "type": "string" },
      "annotations": {
        "type": "object",
        "properties": {
          "readOnlyHint": { "type": "boolean" },
          "destructiveHint": { "type": "boolean" },
          "idempotentHint": { "type": "boolean" },
          "openWorldHint": { "type": "boolean" }
        }
      },
      "examples": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["input"],
          "properties": {
            "description": { "type": "string" },
            "input": {},
            "output": {}
          }
        }
      },
      "permissions": { "type": "array", "items": { "type": "string" } },
      "tags": { "type": "array", "items": { "type": "string" } },
      "timeoutMs": { "type": "integer", "minimum": 100, "maximum": 300000 },
      "uiTitle": { "type": "string" },
      "subagent": {
        "type": "object",
        "required": ["systemPrompt"],
        "properties": {
          "systemPrompt": { "type": "string", "minLength": 1 },
          "allowedTools": { "type": "array", "items": { "type": "string" } },
          "maxTurns": { "type": "integer", "minimum": 1, "maximum": 50, "default": 8 },
          "model": { "type": "string" },
          "resultSchema": { "type": "object" },
          "allowBackground": { "type": "boolean", "default": false }
        }
      }
    },
    "allOf": [
      {
        "if": { "properties": { "executionType": { "const": "subagent" } }, "required": ["executionType"] },
        "then": { "required": ["subagent"] }
      }
    ]
  }
},
"schedule": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["cron", "method"],
    "properties": {
      "cron": { "type": "string" },
      "method": { "type": "string" },
      "description": { "type": "string" },
      "maxConcurrent": { "type": "integer", "minimum": 1, "default": 1 }
    }
  }
}
```

---

## 10. 구현 우선순위

| 단계 | 작업 | 난이도 | 영향 | 레퍼런스 |
|------|------|--------|------|---------|
| **P1** | `tools[]` 필드 + `plugin-tool-adapter.ts` dispatcher | M | LLM 호출 정확도 즉시 향상 | — |
| **P1** | `plugin.schema.json` 검증 추가 | S | 플러그인 오류 조기 발견 | — |
| **P2** | `ToolRegistry.createScopedView()` | S | 서브에이전트 사전 조건 | — |
| **P2** | `hostApi.spawnSubagent()` + scoped ConversationLoop + `historyPolicy` | M-L | 서브에이전트 실행 | OpenAI input_filter |
| **P2** | Capability 기반 권한 강제 (`permissions[]` → PermissionManager RPC) | M | 보안 강화 | Paperclip |
| **P2** | `manifest.schedule[]` + 호스트 cron 스케줄러 | M | pageindex 30s polling 해소 | OpenHarness CronCreate |
| **P3** | `subagent.allowBackground` + `runInBackground` 파라미터 처리 | S | 장기 실행 fire-and-forget 작업 | Claude Code Agent.run_in_background |
| **P3** | `annotations` → PermissionManager 연동 | S | 승인 시스템 강화 | MCP 2025-06-18 |
| **P3** | Hot reload (`PluginRuntime.reload(id)`) | M | 마켓플레이스 UX | — |
| **P4** | 병렬 서브에이전트 (fork/join ConversationLoop) | XL | 복합 분석 작업 | LangGraph |

---

## 11. 엣지 케이스 처리

| 케이스 | 처리 방법 |
|--------|----------|
| `tools[].name`이 runtime handler에 없음 (subagent 제외) | 플러그인 로드 실패 + 명확한 오류 메시지 |
| 다른 플러그인과 tool name 중복 | 경고 로그 + 해당 tool skip (플러그인은 계속 동작) |
| `inputSchema` malformed | ajv meta-validate 실패 → generic payload fallback + 경고 |
| legacy `methods[]`만 존재 | 기존 동작 유지, generic payload schema |
| `subagent.allowedTools`가 존재하지 않는 tool | 로드 시 경고, 런타임에 해당 tool 노출 안 함 |
| 서브에이전트 depth 초과 | `depth exceeded` 오류를 tool_result로 반환 |
| `subagent.allowBackground:true`인데 LLM이 `runInBackground:false` 전달 | 동기 실행으로 처리 (allowBackground는 허용 여부, 강제 아님) |

---

## 12. 개발 방향 요약

### 핵심 방향 전환 (레퍼런스 분석 결론)

레퍼런스 3개(claw-code, OpenHarness, Paperclip) + 상용 CLI 6개 분석 결과, LVIS 스키마는 **선언형 완결성** 측면에서 현존 시스템 중 가장 앞서 있다. `executionType` 단일 필드로 실행 모드를 tool 메타데이터 레벨에서 선언하는 시스템은 없다.

단, **런타임 신뢰성**에서 격차가 있다:

| 영역 | 현재 LVIS | 목표 (레퍼런스 기반) |
|------|---------|-------------------|
| 권한 강제 | 선언만 있음 (no enforcement) | Capability-based RPC 강제 (Paperclip) |
| 플러그인 격리 | in-process | hot-reload 지원 → 마켓플레이스 UX |
| 스케줄 실행 | 플러그인 자체 폴링 | 호스트 cron 스케줄러 — `manifest.schedule[]` 블록 (OpenHarness) |
| 서브에이전트 컨텍스트 | userMessage 문자열만 | historyPolicy + summaryCutoff |

### 마일스톤

```
M1 (P1): 스키마 선언 → LLM 호출 정확도 향상
  └─ tools[] dispatcher + plugin.schema.json 검증

M2 (P2): 런타임 신뢰성
  └─ 서브에이전트 실행 + Capability 권한 강제 + manifest.schedule[] 스케줄 실행

M3 (P3): 마켓플레이스 준비
  └─ allowBackground 처리 + Hot reload + annotations 연동

M4 (P4): 고급 에이전트
  └─ 병렬 서브에이전트 (fork/join)
```

### 결정하지 않은 것

1. **`CapabilityScope` 표준화 시점**: P2 시작 전 범위 확정 필요 (현재 열거형 초안만 존재).
2. **worker_threads vs child_process 선택**: Electron 메인 프로세스에서 worker_threads가 안정적인지 검증 필요 (Electron 30+ 권장).
3. **스케줄러 구현체**: node-cron vs 자체 구현. pageindex 폴링 교체 시 함께 결정.

---

## 참조

### 표준 스펙
- MCP 2025-06-18 Specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Anthropic Tool Use Guide: https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/implement-tool-use
- OpenAI Agents SDK Handoffs: https://openai.github.io/openai-agents-python/handoffs/
- VSCode Extension Manifest / Agent Plugins: https://code.visualstudio.com/api/references/extension-manifest
- Continue.dev config.yaml Reference: https://docs.continue.dev/reference
- GitHub Copilot Extensions: https://docs.github.com/en/copilot/building-copilot-extensions/about-building-copilot-extensions

### 레퍼런스 구현
- claw-code / OpenClaw: https://github.com/ultraworkers/claw-code
- Paperclip Plugin Spec: https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md
- Paperclip Plugin System (DeepWiki): https://deepwiki.com/paperclipai/paperclip/9-plugin-system

### LVIS 내부
- LVIS Architecture §6 (ToolRegistry, PermissionManager): `docs/architecture/architecture.md`
- LVIS Architecture §8 (AgentApproval): `docs/architecture/architecture.md`
- LVIS Architecture §9 (Plugin System): `docs/architecture/architecture.md`
- LVIS 보안 아키텍처 레퍼런스: `~/.claude/projects/.../memory/reference_security_architecture.md`

### 현행 코드 참조

| 역할 | 파일 |
|------|------|
| Tool 계약 | `src/tools/base.ts:45-66` |
| 현행 어댑터 | `src/plugins/plugin-tool-adapter.ts:30-74` |
| ToolRegistry | `src/tools/registry.ts:77-87` |
| PluginManifest 타입 | `src/plugins/types.ts:26-88` |
| 등록 진입점 | `src/boot.ts:522-526` |
| JSON Schema 검증 | `schemas/plugin.schema.json` |
