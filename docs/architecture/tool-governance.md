# Unified Tool Governance Architecture — §6.3 + §9.5 + §14.2 보충

> **상위 문서**: `architecture.md` v4 Final
> **범위**: 모든 도구 계층(Builtin, Plugin, MCP)의 통합 보안 모델
> **최종 수정**: 2026-04-12

---

## 1. 문제 정의

LVIS는 3개 소스에서 도구를 등록한다:

| 소스 | 예시 | 신뢰 수준 | 위험 |
|------|------|-----------|------|
| **Builtin** | memory_save, web_search | 높음 (코드 리뷰됨) | 호스트 내부 동작 |
| **Plugin** | meeting_start, index_scan | 중간 (매니페스트 검증) | HostApi 범위 내 동작 |
| **MCP** | mcp_hr_query, mcp_erp_read | 낮음 (외부 프로세스/서비스) | 네트워크 연결 가능 |

**핵심 원칙**: 소스에 관계없이 모든 도구 호출은 **단일 실행 파이프라인**을 통과해야 하며, **모든 호출은 명시적으로 검토 가능**해야 한다.

---

## 2. Trust Level 모델

```
┌─────────────────────────────────────────────────────┐
│                    Tool Registry                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Builtin  │  │ Plugin   │  │ MCP              │  │
│  │ trust:   │  │ trust:   │  │ trust:           │  │
│  │  HIGH    │  │  MEDIUM  │  │  LOW             │  │
│  │          │  │          │  │                  │  │
│  │ 호스트   │  │ HostApi  │  │ 외부 프로세스    │  │
│  │ 내부     │  │ 샌드박스 │  │ 네트워크 연결    │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ 모든 호출
                       ▼
            ┌─────────────────────┐
            │   ToolExecutor      │
            │   (Single Choke     │
            │    Point)           │
            └─────────────────────┘
```

### 2.1 Trust Level 정의

| Trust | 소스 | 기본 권한 | 감사 수준 | 속도 제한 |
|-------|------|-----------|-----------|-----------|
| **HIGH** | builtin | allow (조회), ask (변경) | summary | 없음 |
| **MEDIUM** | plugin | default mode (§6.3) | full | 분당 60회 |
| **LOW** | mcp | strict (항상 검토) | full + args | 분당 20회 |

### 2.2 Trust 결정 규칙

```
if (tool.source === "builtin") → trust = HIGH
if (tool.source === "plugin")  → trust = MEDIUM
if (tool.source === "mcp")     → trust = LOW

// 예외: 관리자가 특정 도구의 trust를 수동 승격/강등 가능
if (governancePolicy.trustOverrides[tool.name]) → 오버라이드 적용
```

---

## 3. Single Choke Point: ToolExecutor 8-Step Pipeline

**모든 도구 호출은 예외 없이 이 파이프라인을 통과한다.**

```
Step 1: Lookup        — ToolRegistry.findByName() + 소스/trust 확인
                        │
Step 2: PreHook       — HookRunner.preToolUse() — 입력 검사/변환
                        │
Step 3: Permission    — PermissionManager.check(name, source, trust)
         │              ├─ DENY  → 차단 + 감사 로그 + 즉시 반환
         │              ├─ ASK   → Layer 3 승인 대기 (UI)
         │              └─ ALLOW → 계속
         │
Step 4: Governance    — GovernancePolicy.validate(name, source, args)
         │              ├─ Plugin: 매니페스트 선언 메서드만 허용
         │              ├─ MCP: 화이트리스트 + 네임스페이스 + 범위 검증
         │              └─ Builtin: 항상 통과
         │
Step 5: Rate Limit    — RateLimiter.check(name, source, sessionId)
         │              └─ 초과 시 → 일시 차단 + 감사 로그
         │
Step 6: Execute       — tool.execute(args) — 실제 실행
         │
Step 7: PostHook      — HookRunner.postToolUse() — 결과 검사
         │              └─ 민감 데이터 감지 시 마스킹 (DLP)
         │
Step 8: Audit + Result — AuditLogger.logToolCall() — 전체 기록
                          │
                          └─ { toolName, source, trust, args(sanitized),
                               result(truncated), permissionDecision,
                               executionTimeMs, isError, sessionId, timestamp }
```

### 3.1 Pipeline 불변 규칙

1. **우회 불가**: 어떤 코드도 ToolExecutor를 거치지 않고 도구를 실행할 수 없다
2. **감사 필수**: Step 8은 항상 실행된다 (에러 시에도)
3. **순서 고정**: Step 1-8은 반드시 순서대로 실행
4. **실패 격리**: Step 6(Execute) 실패가 Step 8(Audit)을 건너뛰지 않음

---

## 4. Source-Aware Permission Model

### 4.1 PermissionManager 확장

```
check(toolName, source, trust) → ALLOW | DENY | ASK

판정 우선순위:
1. Governance deny 규칙           → DENY (최우선, 불변)
2. 관리자 명시 deny 규칙          → DENY
3. 관리자 명시 allow 규칙         → ALLOW
4. 사용자 "항상 허용" 규칙        → ALLOW
5. Trust-based 기본 정책:
   - HIGH  + read-only  → ALLOW
   - HIGH  + write      → ASK
   - MEDIUM + read-only → ALLOW
   - MEDIUM + write     → ASK (default mode)
   - LOW   + any        → ASK (strict 강제)
```

### 4.2 도구 분류: Read vs Write

| 분류 | 기준 | 예시 |
|------|------|------|
| **Read** | 상태를 변경하지 않는 조회 | memory_search, index_documents, web_search |
| **Write** | 상태를 변경하거나 외부에 영향 | memory_save, meeting_start, email_analyze |
| **Dangerous** | 되돌리기 어려운 파괴적 동작 | (현재 없음, Bash 도구 추가 시 해당) |

---

## 5. MCP 전용 보안 계층 (Trust: LOW)

MCP는 Plugin보다 한 단계 높은 거버넌스가 필요하다.

### 5.1 6-Layer Defense-in-Depth

```
Layer 0: Governance Policy    — IT admin 배포 화이트리스트 (deny-by-default)
Layer 1: Installation Check   — 승인 상태, transport, URL, checksum 검증
Layer 2: Connection Security  — TLS 강제, SSO/mTLS, timeout
Layer 3: Capability Restrict  — 네임스페이스 강제, shadowing 방지, max tools
Layer 4: Runtime Permission   — strict 모드 기본, PermissionManager 연동
Layer 5: Monitoring & Audit   — 전체 연결/호출 JSONL 로깅
Layer 6: Kill Switch          — 즉시 revoke → 도구 해제 → 연결 종료
```

### 5.2 Deny-by-Default 원칙

```
MCP 서버 연결 요청
  │
  ├─ 정책 파일 (~/.lvis/governance/mcp-policy.json) 존재?
  │   └─ 없음 → 모든 MCP 서버 차단
  │
  ├─ 서버 ID가 정책에 등록?
  │   └─ 없음 → 차단 (미승인 서버)
  │
  ├─ 승인 상태 = "approved"?
  │   ├─ "revoked" → 차단 + 알림
  │   └─ "pending" → 차단 + 관리자 알림
  │
  ├─ Transport/URL/Command 검증 통과?
  │   └─ 실패 → 차단 + 감사 로그
  │
  └─ 통과 → 연결 허용 → 도구 등록 (네임스페이스 적용)
```

### 5.3 네임스페이스 격리

MCP 도구는 반드시 `mcp_{prefix}_{name}` 형식:
- `hr-system` 서버의 `query` → `mcp_hr_query`
- `erp` 서버의 `read_order` → `mcp_erp_read_order`

이로써:
- Builtin/Plugin 도구와 이름 충돌 불가
- 도구 이름만으로 소스 식별 가능
- 서버 revoke 시 prefix로 일괄 해제

---

## 6. Plugin 도구 거버넌스 (Trust: MEDIUM)

### 6.1 등록 시점 검증

```
Plugin 로드 시:
  │
  ├─ 매니페스트 methods[] 선언과 실제 handler 일치?
  │   └─ 불일치 → 에러 + 로드 실패
  │
  ├─ 도구 이름이 plugin_{id}_ 네임스페이스? (권장, 강제 아님)
  │
  └─ ToolRegistry 등록 → source: "plugin", pluginId 기록
```

### 6.2 플러그인 제거 시

```
Plugin 제거:
  ├─ ToolRegistry.unregisterByPlugin(pluginId)
  ├─ KeywordEngine에서 해당 키워드 제거
  └─ 호스트 앱은 정상 동작 유지 (graceful degradation)
```

---

## 7. Builtin 도구 거버넌스 (Trust: HIGH)

### 7.1 특징
- 코드 리뷰를 거친 호스트 내장 도구
- PermissionManager의 최소 제약 적용
- Read 도구는 자동 허용, Write 도구는 default mode

### 7.2 Builtin 도구 목록 (현재)

| 도구 | 분류 | 기본 권한 |
|------|------|-----------|
| memory_save | write | ask (default) |
| memory_search | read | allow |
| memory_list | read | allow |
| web_search | read | allow |
| web_fetch | read | allow |

---

## 8. 감사 로그 스키마 (통합)

모든 도구 호출은 동일한 스키마로 기록:

```typescript
interface ToolCallAuditEntry {
  // 식별
  timestamp: string;       // ISO 8601
  sessionId: string;       // 대화 세션
  turnIndex: number;       // 턴 순서
  toolCallId: string;      // 개별 tool call 고유 ID
  groupId: string;         // 같은 턴/배치에서 묶이는 ID
  displayOrder: number;    // 그룹 내 표시 순서

  // 도구 정보
  toolName: string;        // 실행된 도구
  source: "builtin" | "plugin" | "mcp";
  trustLevel: "high" | "medium" | "low";
  pluginId?: string;       // plugin 소스 시
  mcpServerId?: string;    // mcp 소스 시

  // 실행 정보
  input: string;           // sanitized (민감 정보 마스킹)
  output: string;          // truncated (최대 1KB)
  executionTimeMs: number;
  isError: boolean;
  error?: {
    message: string;
    code: string;
    stderr?: string;
    exitCode?: number;
    suggestion?: string;
  };
  groupFailureCount?: number;
  groupTotalCount?: number;

  // 거버넌스 정보
  permissionDecision: "allow" | "deny" | "ask-approved" | "ask-denied";
  governanceCheckPassed: boolean;
  rateLimitRemaining: number;

  // 위험 플래그
  riskFlags: string[];     // e.g., ["external_network", "file_write", "high_latency"]
}
```

### 8.1 Tool Call Grouping Contract

- UI는 `groupId` 기준으로 도구를 모아 **접힌 카드**로 먼저 보여준다.
- 카드 제목은 `USED <TOOL / CATEGORY> (N CALLS)` 형식을 따른다.
- 카드 배지는 `✅ Success`, `⚠️ Partial`, `❌ Failed` 중 하나로 표시한다.
- 카드 안에서는 `displayOrder` 순서대로 도구를 나열한다.
- 개별 도구를 펼치면 `input`이 먼저 보이고, 그 아래에 `output` 또는 `error`가 보인다.
- 실패는 항상 도구 단위로만 표기하고, 같은 그룹의 다른 도구는 독립적으로 유지한다.
- `groupFailureCount`와 `groupTotalCount`는 렌더러가 계산하지 않고 감사 로그에서 그대로 사용한다.
- `error.code`는 `TIMEOUT`, `PERMISSION_DENIED`, `TOOL_NOT_FOUND`, `PLATFORM_MISMATCH`처럼 짧은 안정 키를 사용한다.

### 8.1.1 Group Failure Semantics

| 상태 | 조건 | 그룹 카드 | 패치 요약 |
| --- | --- | --- | --- |
| `✅ Success` | 실패 0 | 정상 | 없음 |
| `⚠️ Partial` | 1개 이상 실패, 1개 이상 성공 | 접힌 카드 유지 | 실패한 도구만 1줄 요약 |
| `❌ Failed` | 전부 실패 | 접힌 카드 유지 | 첫 실패 원인 + 실패 개수 |

- `spawn sh ENOENT`는 `PLATFORM_MISMATCH`로 기록한다.
- Bash 도구 실패는 턴 전체 실패로 승격하지 않는다.

### 8.2 감사 로그 저장

```
~/.lvis/audit/
  ├── 2026-04-12.jsonl        ← 일별 JSONL (자동 생성)
  ├── 2026-04-11.jsonl
  └── ...

향후: Elasticsearch 연동 시 실시간 스트리밍 (§14.2)
```

---

## 9. Rate Limiting

### 9.1 계층별 제한

| 계층 | Trust | 분당 제한 | 세션당 제한 | 초과 시 |
|------|-------|-----------|------------|---------|
| Builtin | HIGH | 없음 | 없음 | — |
| Plugin | MEDIUM | 60회 | 500회 | 일시 차단 + 경고 |
| MCP | LOW | 20회 | 100회 | 차단 + 감사 + 알림 |

### 9.2 Token Bucket 알고리즘

```
각 (source, serverId/pluginId) 조합에 독립 버킷:
  - capacity: 분당 제한
  - refillRate: 1초당 capacity/60
  - consume(1) on each call
  - if empty → rate_limited error
```

---

## 10. Kill Switch 메커니즘

### 10.1 MCP 서버 즉시 중단

```
관리자 revoke(serverId):
  1. 정책 파일 업데이트: status = "revoked"
  2. McpManager.disconnect(serverId)
  3. ToolRegistry.unregisterByMcp(serverId) — prefix 기반 일괄
  4. AuditLogger.log("kill_switch", { serverId, revokedBy })
  5. 진행 중인 tool_call 있으면 → timeout 강제 → error 반환
```

### 10.2 Plugin 비활성화

```
관리자 disable(pluginId):
  1. PluginRuntime.stopPlugin(pluginId)
  2. ToolRegistry.unregisterByPlugin(pluginId)
  3. KeywordEngine.removeByPlugin(pluginId)
  4. AuditLogger.log("plugin_disabled", { pluginId })
```

### 10.3 전체 비상 정지

```
관리자 emergencyStop():
  1. 모든 MCP 연결 종료
  2. 모든 Plugin 중지
  3. Builtin만 동작
  4. 사용자에게 "관리자에 의해 제한된 모드" 표시
```

---

## 11. 데이터 흐름 보안 (DLP)

### 11.1 PostHook 민감 데이터 검사

도구 실행 결과(Step 7)에서 민감 데이터 패턴 검사:

| 패턴 | 예시 | 조치 |
|------|------|------|
| 주민등록번호 | `\d{6}-[1-4]\d{6}` | 마스킹: `******-*******` |
| 신용카드 | `\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}` | 마스킹: `****-****-****-1234` |
| API 키 | `sk-[a-zA-Z0-9]{20,}` | 마스킹: `sk-****` |
| 이메일 주소 | (MCP 결과에서 외부 유출 시) | 도메인만 표시 |

### 11.2 입력 Sanitization

도구 호출 입력을 감사 로그에 기록 시:
- 파일 경로: 허용 범위 내인지 확인
- URL: 허용 목록 내인지 확인
- 텍스트: 최대 500자 truncate

---

## 12. 레퍼런스 기반 보강 (claw-code + ccleaks.com/architecture)

> 아래 항목은 검증된 프로덕션 시스템(Claude Code 아키텍처, claw-code Rust 포트)에서
> 관찰된 패턴을 LVIS에 적용한 것이다.

### 12.1 Layer 1 도구 비가시성 원칙 (ccleaks.com §Permission)

> "Tool Registry Filter removes denied tools before Claude's context is built.
>  Claude never sees — and cannot call — tools blocked at this layer."

**핵심**: deny된 도구는 LLM의 system prompt에 포함되지 않아야 한다.
LLM이 존재를 모르면 hallucination으로도 호출할 수 없다.

```
SystemPromptBuilder.build()
  └─ toolRegistry.getVisibleTools()   ← deny 규칙 적용 후 반환
       └─ getToolSchemas()            ← 여기서 LLM에 전달
```

**검증 포인트**: `getVisibleTools()`가 MCP revoked 서버의 도구도 제외하는지 확인.

### 12.2 Workspace Boundary Validation (claw-code Lane 3: file_ops.rs)

> claw-code `file_ops.rs` (744 LOC): binary detection, size limits,
> canonical workspace-boundary validation, symlink escape prevention.

**LVIS 적용**: 모든 파일 접근 도구(향후 FileRead/FileWrite 추가 시)에 적용.

```typescript
interface WorkspaceBoundary {
  /** 허용된 작업 디렉토리 목록 */
  allowedRoots: string[];
  /** 최대 읽기 크기 (바이트) */
  maxReadSize: number;    // default: 10MB
  /** 최대 쓰기 크기 (바이트) */
  maxWriteSize: number;   // default: 5MB
  /** 바이너리 파일 접근 차단 */
  blockBinary: boolean;   // default: true
}

검증 단계:
1. realpath() 로 canonical path 확보 (symlink resolve)
2. canonical path가 allowedRoots 중 하나의 하위인지 확인
3. 파일 크기 확인 (maxReadSize/maxWriteSize)
4. NUL 바이트 존재 시 binary로 판정 → 차단
```

**MCP 도구에 특히 중요**: MCP 서버가 요청하는 파일 경로가
policy에 선언된 `allowedFilePathPatterns` 범위 내인지 검증.

### 12.3 Bash 검증 매트릭스 (claw-code Lane 1: bash_validation.rs)

> Claude Code upstream: 18개 bash 검증 서브모듈
> claw-code 포트: readOnlyValidation, destructiveCommandWarning,
> modeValidation, sedValidation, pathValidation, commandSemantics

**LVIS Bash 도구 추가 시 필수 적용:**

| 서브모듈 | 검증 대상 | 위험 등급 |
|---------|----------|----------|
| destructiveCommandWarning | rm -rf, git reset --hard | Critical |
| readOnlyValidation | read-only 모드에서 write 명령 차단 | High |
| pathValidation | workspace boundary 외부 접근 차단 | High |
| commandSemantics | curl\|bash, eval, $(subshell) | High |
| sedValidation | sed -i 파괴적 변경 | Medium |
| modeValidation | sudo, chmod 777, chown | Medium |

**구현 권장**: AST 파서 대신 [DCG](https://github.com/Dicklesworthstone/destructive_command_guard)
외부 바이너리를 Sub-millisecond 훅으로 통합.

### 12.4 Permission Prompt UX 3-Choice (ccleaks.com §Permission Layer 3)

> "If no rule matches, execution halts. Choices: allow once · allow always · deny."

**LVIS IPC 설계:**

```
Main → Renderer: "lvis:permission:ask"
  { toolName, source, trust, input(sanitized), reason }

Renderer → Main: "lvis:permission:respond"
  { toolName, decision: "allow-once" | "allow-always" | "deny" }

allow-always → PermissionManager.addAlwaysAllowed(toolName)
```

### 12.5 11-Step Boot Sequence (ccleaks.com §Boot)

우리 Boot Sequence(§4.2)와 비교:

| Step | Claude Code (ccleaks) | LVIS 현재 | Delta |
|------|----------------------|-----------|-------|
| 1 | CLI loads | Electron shell init | ✓ |
| 2 | **Feature flags evaluated** | 없음 | §14.4 |
| 3 | main.tsx init | boot.ts init | ✓ |
| 4 | Config loaded (settings, CLAUDE.md) | SettingsService | ✓ |
| 5 | **Auth checked (OAuth)** | 없음 | SSO Phase 4 |
| 6 | **GrowthBook initialized** | 없음 | §14.4 |
| 7 | **Tools assembled (43 built-in + MCP)** | core builtins + native file tools + plugins | 확장 중 |
| 8 | **MCP servers connected** | 없음 | 이번 구현 |
| 9 | System prompt built (10+ sources) | 6/12 sources | 확장 중 |
| 10 | REPL launched | Electron UI ready | ✓ |
| 11 | Query loop begins | ConversationLoop | ✓ |

### 12.6 Extension Point 아키텍처 (ccleaks.com §Extension)

Claude Code는 6개 확장 메커니즘을 제공:

| 메커니즘 | Claude Code | LVIS 대응 | 상태 |
|---------|------------|-----------|------|
| MCP Servers | 24파일 구현 | mcp/ 모듈 | 거버넌스 완료, Client 구현 중 |
| Custom Agents | ~/.claude/agents/*.md | 없음 | Phase 3 |
| Skills | ~/.claude/skills/ | KeywordEngine skill routing | ✓ |
| CLAUDE.md | @import 합성 | LVIS.md + notes/ | ✓ |
| Plugins | Marketplace | PluginRuntime | ✓ |
| Hooks | Pre/Post ToolUse | HookRunner | ✓ |

---

## 13. 구현 로드맵

### Phase 1 (완료)
- [x] ToolRegistry source/trust 추적 (builtin/plugin/mcp)
- [x] PermissionManager source-aware (trust-based 기본 정책)
- [x] AuditLogger (JSONL per-turn + tool-call 수준)
- [x] MCP Governance Policy (deny-by-default whitelist)
- [x] Rate Limiter (Token Bucket, trust별)
- [x] 8-Step ToolExecutor Single Choke Point

### Phase 2 (단기)
- [ ] MCP Client (stdio transport) — §12.5 Step 8
- [ ] MCP Client (SSE transport) — enterprise API 연동
- [ ] Permission Prompt UI (allow once / allow always / deny) — §12.4
- [x] Native file tools Phase 1 — `read_file`, `list_files`, `glob_files`, `grep_files`, `write_file`, `edit_file`
- [x] Workspace Boundary Validation — §12.2 (canonical path, symlink escape, future-create parent realpath)
- [x] Native tools Phase 2 — `apply_patch`, `move_file`, `delete_file`, `powershell`
- [ ] DLP PostHook (민감 데이터 마스킹)
- [ ] Kill Switch UI

### Phase 3 (중기)
- [ ] Bash 도구 + DCG 훅 통합 — §12.3
- [ ] Feature Flag 서비스 (GrowthBook) — §12.5 Step 2, 6
- [ ] SSO/mTLS 인증 연동 — §12.5 Step 5
- [ ] MCP 서명 검증 (PKI)
- [ ] Custom Agent 시스템 (*.md 기반) — §12.6
- [ ] Plugin V8 Isolate 샌드박스

### Phase 4 (장기)
- [ ] Elasticsearch 감사 로그 연동
- [ ] OPA Policy Engine 통합
- [ ] MCP WebSocket transport
- [ ] 이상 탐지 (비정상 호출 패턴)
- [ ] 관리자 대시보드 (감사 로그 검색/시각화)
