# Q12 Permission Policy — 10-Layer Design Document

> **Status:** Draft v1 — multi-agent review pending
> **Issue:** #627
> **PR:** #632 (feat/q12-permission-policy)
> **Last updated:** 2026-05-09

## 0. Purpose & scope

PR #626 (Routine v2) 의 production smoke test 에서 발견된 *headless routine 자율 주행 + 권한 dialog 0 tool 호출* 을 root cause 로, **defense-in-depth 의 두 번째 layer** (tool-level fine-grained authorization) 를 구축한다. Q11 (Overlay Runner) 가 *user-in-the-loop staging* 을 담당하는 것과 짝을 이룬다.

**범위 (in-scope):**
- Tool 호출 권한 model (read/write/shell/network × built-in/plugin)
- Routine headless 안전 모델 (reviewer agent + deferred queue)
- Hook system (Pre/PostToolUse + PermissionRequest)
- Allowed directories layer
- Runtime mode toggle (`/permission` slash)
- Audit schema 보강

**범위 외 (out-of-scope):**
- Network firewall (이건 OS/Tailscale layer)
- Plugin sandbox (이건 §9 — 변경 없음)
- LLM provider authentication (이건 §15)

## 1. Design principles

| 원칙 | 적용 |
|---|---|
| **Fail-safe defaults** | 미선언 category → manifest 검증 fail (옛 fail-permissive 폐지). plugin 의 `isReadOnly()` 무시 (trust boundary) |
| **Defense in depth** | Layer 0 (sensitive paths) → Layer 1 (allowed dirs) → Layer 2 (action model) → Layer 3 (category) → Layer 4 (scope) → Layer 5 (reviewer) → Layer 6 (hooks) → Layer 7 (audit) → Layer 8 (mode toggle) → Layer 9 (sandbox) → Layer 10 (cross-cutting dirs) |
| **Atomic cutover** | Backward-compat shim 금지 (CLAUDE.md No-Fallback 룰). Plugin manifest category 미선언 → boot fail. 6 plugin 동시 PR 으로 cutover staging |
| **User-in-the-loop > silent** | Headless 의 implicit allow 폐지. Reviewer agent (LOW/MED auto+audit, HIGH deferred queue) 또는 LLM-free 경로 (모든 write deferred) |
| **Multi-vendor neutrality** | Reviewer agent 가 Anthropic Haiku 만 의존하지 않음 — provider/model 설정 가능 + LLM-free path |
| **Path-aware** | Tool 의 path 인자 가 allowed directories 에 매치 안 되면 confirm + auto-suggest |

## 2. 10-Layer model

```
┌────────────────────────────────────────────────────────────┐
│  Layer 0:  Sensitive paths (deny-list, hard-block)         │
│   ├ ~/.ssh/, ~/.aws/credentials, ~/.netrc, /etc/shadow…   │
│   └ canonicalize(path) → realpath → glob 매치 (symlink 포함)  │
├────────────────────────────────────────────────────────────┤
│  Layer 1:  Allowed directories (allow-list, confirm-gate)  │
│   ├ permissions.allowedDirectories[]                       │
│   ├ 외부 path → confirm + auto-suggest 추가                 │
│   └ /permission allow-dir <path> + /permission list-dirs    │
├────────────────────────────────────────────────────────────┤
│  Layer 2:  Action model (allow / ask / deny)               │
│   └ deny precedence — hook deny / sensitive deny override  │
├────────────────────────────────────────────────────────────┤
│  Layer 3:  Category × Source                                │
│   ├ Built-in × read   → allow (silent)                     │
│   ├ Built-in × write  → ask                                │
│   ├ Built-in × shell  → ask + Bash AST                     │
│   ├ Built-in × network → ask + endpoint surface            │
│   ├ Plugin  × read   → allow if scope ∋ pluginId           │
│   ├ Plugin  × write  → ask                                  │
│   ├ Plugin  × shell  → ask + Bash AST                       │
│   └ Plugin  × network → ask + endpoint surface             │
├────────────────────────────────────────────────────────────┤
│  Layer 4:  Subscription scope (routine.allowedPlugins[])   │
│   └ invocation-time enforce, registration-time validate    │
├────────────────────────────────────────────────────────────┤
│  Layer 5:  Reviewer agent (configurable, multi-vendor)     │
│   ├ Mode: disabled / rule-based / llm                      │
│   ├ Model: Haiku / gpt-4o-mini / gemini-flash / …          │
│   ├ Verdict: LOW (auto+audit) / MED (auto+audit) / HIGH (defer) │
│   └ Triggered on routine headless write/shell/network only │
├────────────────────────────────────────────────────────────┤
│  Layer 6:  Hook chain (Pre/Post/PermissionRequest)         │
│   ├ ~/.lvis/hooks/{pre,post}-{tool}*.sh                    │
│   ├ Sequential, deny precedence (deny 후 user override 불가) │
│   └ Hook output: allow / modify / deny + reason             │
├────────────────────────────────────────────────────────────┤
│  Layer 7:  Audit (every decision)                          │
│   └ ~/.lvis/audit.log: { ts, tool, source, category,       │
│       directory, scope, decision, layer, reviewer?,        │
│       hookChain?, allowedDirectories?, allowedPlugins? }    │
├────────────────────────────────────────────────────────────┤
│  Layer 8:  Runtime mode toggle (/permission slash)         │
│   ├ Modes: strict / default / auto                          │
│   ├ Persistence: settings.json (session OR durable)         │
│   └ /permission auto session  ·  /permission strict durable │
├────────────────────────────────────────────────────────────┤
│  Layer 9:  Sandbox (Electron preload/contextBridge)        │
│   └ 변경 없음 (host trust 모델 유지)                        │
├────────────────────────────────────────────────────────────┤
│  Layer 10: Allowed directories cross-cutting               │
│   └ Layer 1 의 정책이 모든 path-bearing tool 에 적용        │
└────────────────────────────────────────────────────────────┘
```

## 3. Layer-by-layer detail

### Layer 0 — Sensitive paths (existing, hardened)

**Already in:** `src/permissions/sensitive-paths.ts` (PR #626 기반).

**Q12 보강:**

1. **Symlink resolution** — `path.resolve()` 외에 `realpathSync.native()` walk-up. ` ~/work/cred → ~/.ssh/id_rsa` symlink 가 hard-block 우회하던 vulnerability 차단 (security review MAJOR-1).

```typescript
export function canonicalizePathForMatch(rawPath: string): string {
  let canonical = pathResolve(rawPath);
  try {
    canonical = realpathSync.native(canonical);
  } catch {
    // realpath 실패 (파일 없음): 가장 가까운 존재하는 ancestor 의 realpath + relative
    let parent = canonical;
    while (parent !== pathResolve(parent, "..")) {
      parent = pathResolve(parent, "..");
      try {
        canonical = pathResolve(realpathSync.native(parent), pathRelative(parent, canonical));
        break;
      } catch { /* keep walking */ }
    }
  }
  return canonical
    .replace(/\/+/g, "/")
    .normalize("NFC")
    .toLowerCase(); // darwin/win32 only
}
```

2. **Sensitive list 확대:**
   - `/etc/shadow`, `/etc/sudoers`, `/etc/passwd-`
   - `~/.netrc`, `~/.pgpass`, `~/.npmrc` (auth tokens)
   - `~/.bash_history`, `~/.zsh_history`, `~/.python_history`, `~/.psql_history`
   - `~/Library/Cookies/**`, `~/.config/**/Login Data`
   - `**/.env`, `**/.env.*`
   - `**/id_ed25519`, `**/id_ecdsa`, `**/id_rsa` outside `.ssh/`

3. **`extractTargetFilePath` 확장** — `path | file_path | filePath` 외에 `target | dst | destination | output | to | source | src`. 또는 모든 string field scan + `isSensitivePath` 적용.

**References:**
- Codex CLI workspace-write boundary
- Claude Code permissions deny-list

### Layer 1 — Allowed directories (NEW)

**파일:** `src/permissions/allowed-directories.ts` (new)

**설정:** `~/.lvis/settings.json`:
```jsonc
{
  "permissions": {
    "allowedDirectories": [
      "~/workspace/lvis",
      "~/.lvis"
    ]
  }
}
```

**Default:** project root (`process.cwd()`) + `~/.lvis/` (host data namespace).

**Behavior:**
1. Path-bearing tool 의 input path 추출
2. `canonicalizePathForMatch` 후 `allowedDirectories` 의 *어느 하나에든* prefix-매치 → allow Layer 1
3. 매치 실패 → confirm dialog + **auto-suggest** ("이 디렉토리 영구 추가?")
4. Routine headless 에서 매치 실패 → reviewer agent → HIGH risk → defer

**Auto-suggest heuristic (Layer 1.5):**
- 최근 30턴 안에 *동일 디렉토리* 의 다른 path 가 N≥3 회 참조됨 → "자주 참조 패턴 감지" → 디렉토리 영구 추가 버튼 promote
- 최근 24h 안에 *동일 path* 가 K≥2 회 거부됨 → "자주 거부 — 차단 권장" 메시지

**Slash commands (Layer 8 와 통합):**
```
/permission allow-dir ~/Documents/old-project
/permission allow-dir ~/Documents/old-project --session  # 세션 한정
/permission deny-dir /tmp/staging
/permission list-dirs
```

**References:**
- Claude Code `permissions.additionalDirectories`
- Codex `--cd` workspace-write boundary
- Cursor `.cursorignore` (deny-list 측면)

### Layer 2 — Action model (existing, no change)

PermissionManager.checkDetailed 의 `decision: "allow" | "ask" | "deny"` 유지. Deny precedence:
1. Layer 0 sensitive deny (always wins)
2. Hook deny (Layer 6)
3. Routine scope deny (Layer 4)
4. Layer 1 directory deny (when 거부 + durable)
5. Permission rules deny (.lvis/permissions.json)

### Layer 3 — Category × Source (NEW: 6-axis from 3-axis)

**Old:** `ToolCategory = "read" | "write" | "dangerous"`
**New:** `ToolCategory = "read" | "write" | "shell" | "network"`

**Migration map:**
- `bash.ts` `category: "dangerous"` → `category: "shell"`
- `agent-spawn.ts` `category: "dangerous"` → `category: "write"`
- `ask-user-question.ts` `category: "dangerous"` → `category: "write"` (executor short-circuit 유지)

**Plugin manifest** (`toolSchemas[*].category`):
- 검증 enum 변경: `"read" | "write" | "shell" | "network"`
- **미선언 → manifest 검증 FAIL** (atomic cutover, fail-safe)
- 6 active plugin 모두 동시 PR 으로 declare

**Decision matrix:**

| source | category | mode=default | mode=auto | mode=strict | headless |
|---|---|---|---|---|---|
| built-in | read | allow (silent) | allow | ask | allow |
| built-in | write | ask | allow + audit | ask | reviewer |
| built-in | shell | ask + AST | ask + AST | ask + AST | reviewer (always) |
| built-in | network | ask + endpoint | allow + audit | ask | reviewer |
| plugin | read | allow if scope ∋ id | allow if scope ∋ id | ask | allow if scope ∋ id |
| plugin | write | ask | allow + audit | ask | reviewer |
| plugin | shell | ask + AST | ask + AST | ask + AST | reviewer (always) |
| plugin | network | ask + endpoint | allow + audit | ask | reviewer |

**Trust boundary (C2 fix from review):**
- For `source === "plugin"`: invocation category 결정 시 *static manifest category* 만 사용. plugin 의 `isReadOnly()` 호출 금지 (plugin-controlled code 가 자기 policy axis 를 결정하면 안 됨).
- For `source === "builtin"`: `isReadOnly(input)` input-aware 분류 OK (host code trusted).

### Layer 4 — Subscription scope (existing, hardened)

**`routine.allowedPlugins: string[]`** propagation 5-layer (이미 PR #632 에 있음):

```
schedule_routine tool → RoutinesStore.add → RoutineRecord persist
  → boot.ts onLlmSession → RoutineEngine.runRoutine
  → ConversationLoop deps.allowedPluginIds
```

**Q12 보강:**
- Empty array `[]` semantics 명시: **deny all plugins** (가장 strict)
- `undefined` semantics 명시: **inherit current chat's active set**
- RoutinePanel UI 의 "전체 허용" 라벨 → "현재 chat 의 active plugin 세트 그대로" 로 수정 (오해 소지)
- `forcedActivePluginIds` 와 `allowedPluginIds` 의 의미 분리:
  - `forcedActivePluginIds`: 키워드 라우팅 무시하고 활성화할 plugin
  - `allowedPluginIds`: 호출 가능 상한선 (intersection)
  - 두 set 이 동일하면 redundant → routine 은 `allowedPluginIds` 만 set, `forcedActivePluginIds` 는 명시 system plugin 만

### Layer 5 — Reviewer agent (NEW, configurable, multi-vendor)

**파일:** `src/permissions/reviewer/risk-classifier.ts` (new)

**설정:**
```jsonc
{
  "permissions": {
    "reviewer": {
      "mode": "llm",      // "disabled" | "rule" | "llm"
      "provider": "anthropic",  // "anthropic" | "openai" | "google" | …
      "model": "claude-haiku-4-5",
      "fallbackOnError": "rule",  // "deny" | "rule" | "allow-and-audit"
      "thresholds": {
        "low": 0.3,
        "medium": 0.7
      }
    }
  }
}
```

**Modes:**

1. **disabled** — Reviewer 호출 안 함. Headless write/shell/network = 무조건 defer.
2. **rule** — LLM 호출 없이 heuristic-based.
   - Bash AST 결과 + sensitive path 근처 + reversibility (rm/curl|sh = HIGH; touch/echo > file = LOW)
   - Tool name pattern (`*_send_*`, `*_post_*` = MED)
   - 일관성 + 빠름 (token 0)
3. **llm** — Provider/model 사용해 SUMMARY_TEMPLATE_PROMPT_V1 으로 risk classify
   - Input: tool name, source, category, finalInput, sensitive paths context
   - Output: { level: "low"|"medium"|"high", reason: string, confidence: number }
   - Token cost: ~500 input + ~50 output per call (Haiku ~ $0.001)

**Provider abstraction:**
```typescript
interface RiskClassifier {
  classify(input: ToolInvocation): Promise<RiskVerdict>;
}

class LlmRiskClassifier implements RiskClassifier {
  constructor(private provider: LlmProvider, private model: string) {}
  // …
}

class RuleBasedRiskClassifier implements RiskClassifier {
  classify(input) { /* heuristic */ }
}

class DisabledRiskClassifier implements RiskClassifier {
  classify(_input) { return Promise.resolve({ level: "high", reason: "disabled" }); }
}
```

**LLM provider neutrality** — 같은 추상화로 Anthropic Haiku, OpenAI gpt-4o-mini, Google gemini-flash 모두 wire-able. provider 별 SDK adapter 는 `src/providers/` 하위에 이미 있음 — 재사용.

**Failure handling:**
- LLM 호출 timeout / quota → `fallbackOnError` 정책 적용
- `rule` fallback 이 안전 default (LOW token cost, deterministic)

**References:**
- Kilo Gatekeeper (AI Safety risk classifier)
- Codex auto_review reviewer
- Claude Code Sonnet 4.6 Classifier

### Layer 6 — Hook system (NEW)

**파일:** `src/permissions/hooks/hook-runner.ts` (already exists for PreToolUse) — extend

**Hook types:**
1. **PreToolUse** — invocation 전에 modify/deny
2. **PostToolUse** — invocation 후 result transform/audit
3. **PermissionRequest** — Layer 3 결정 직전에 intercept (override 가능 단 deny 만)

**Hook discovery:**
- `~/.lvis/hooks/{pre,post,perm}-*.sh` (executable)
- `settings.json` 의 `permissions.hooks: { pre: [...], post: [...] }`
- Plugin manifest 의 hook 도 가능 (Q13 future)

**Hook invocation contract (Claude Code 스타일):**
- stdin: JSON `{ toolName, source, input, sessionId, ... }`
- stdout: JSON `{ action: "allow" | "modify" | "deny", reason, updatedInput? }`
- exit 0 = run, exit !=0 = treated as deny (fail-safe)
- timeout 5s default, configurable

**Deny precedence:**
- 어떤 hook 이든 `action: "deny"` 반환 → 후속 hook + Layer 3 unchanged → 사용자 override **불가능**
- 즉 hook 이 사용자 정책 의 *최종 발언권* 보유

**References:**
- Claude Code PreToolUse / PermissionRequest hooks
- OpenHarness Pre/Post hooks

### Layer 7 — Audit (existing, schema 보강)

**Existing:** `~/.lvis/audit.log` (JSONL, append-only).

**Q12 보강 fields:**
```jsonc
{
  "ts": "2026-05-09T07:42:18.234Z",
  "tool": "bash",
  "source": "builtin",
  "category": "shell",            // NEW: 6-axis
  "directory": "/Users/john/workspace/lvis",  // NEW: cwd or path
  "directoryAllowed": true,        // NEW: Layer 1 result
  "scope": ["agent-hub", "meeting"],  // NEW: routine.allowedPlugins
  "decision": "allow",
  "layer": 3,
  "reviewer": {                    // NEW: Layer 5 verdict
    "level": "low",
    "model": "claude-haiku-4-5",
    "reason": "reversible local op",
    "confidence": 0.85
  },
  "hookChain": [                   // NEW: Layer 6 results
    { "name": "log-all.sh", "action": "allow" },
    { "name": "mask-secrets.sh", "action": "modify" }
  ],
  "rateLimitRemaining": null,      // NEW: undefined instead of Infinity (code-review)
  "auditId": "audit-2026-05-09-001"
}
```

**Retention:** 30일 default, configurable via `permissions.audit.retentionDays`.

**Privacy:** 기존 DLP filter + ask_user_question redaction 그대로 적용.

### Layer 8 — Runtime mode toggle (NEW)

**File:** `src/ui/renderer/slash/permission-handler.ts` (new)

**Slash command grammar:**
```
/permission                          # show current mode
/permission strict                   # strict mode (session)
/permission auto durable             # auto mode (persists to settings.json)
/permission default                  # back to default
/permission allow-dir <path>         # add directory (Layer 1)
/permission allow-dir <path> --session  # session only
/permission deny-dir <path>
/permission list-dirs
/permission list-rules
/permission audit                    # show recent audit entries
/permission reviewer disabled|rule|llm  # toggle Layer 5 mode
/permission reviewer model <name>    # change model
```

**Behavior:**
- `--session` flag → in-memory only, 세션 종료 시 복원
- 없으면 → settings.json persist
- Audit 에 mode 변경 기록

**Modes:**
- **strict** — 모든 ask 가 dialog, auto 모드의 모든 자동 허용 disable
- **default** — Layer 3 decision matrix 그대로
- **auto** — write/network 자동 허용 (ask 만 있는 경우), shell 은 여전히 ask + AST, hook deny / sensitive deny / scope deny 항상 우선

**References:**
- Hermes `/permission` slash
- Copilot `/yolo` `/autoApprove`

### Layer 9 — Sandbox (existing, no change)

Electron preload/contextBridge 모델 유지. Docker 불필요.

### Layer 10 — Allowed directories cross-cutting

Layer 1 의 정책이 모든 path-bearing tool 에 적용됨을 명시. 즉:
- `read_file`, `write_file`, `bash` (cwd), `apply_patch`, `glob` 등
- Plugin tools 가 `path` field 받으면 동일 적용
- HTTP fetch 의 `localhost:port` 는 network 카테고리로 별도 (not Layer 10)

## 4. Reference comparison matrix

| 차원 | LVIS Q12 | OpenCode | OpenHands | Kilo | Warp | Claude Code | OpenHarness | Hermes | Codex CLI | Copilot |
|---|---|---|---|---|---|---|---|---|---|---|
| Action model | 3-action allow/ask/deny + deny precedence ✅ | allow/ask/deny + hierarchy | LOW/MED/HIGH | allow/ask/deny | autonomous/explicit/no-confirm | deny→ask→allow | 4 mode | manual/smart/off | on-request + 5 categories | --allow-tool/--deny-tool/--yolo |
| Read/Write 분리 | 4-axis read/write/shell/network + input-aware ✅ | wildcard | risk level | per-tool | allowlist | tool 단위 | path+command | dangerous patterns | workspace-write boundary | --allow-all-paths |
| Reviewer agent | configurable (disabled/rule/llm) + multi-vendor ✅ | — | LLM self-annotate | AI Safety Gatekeeper | — | Sonnet 4.6 Classifier | — | Tirith verdict | auto_review reviewer | — |
| Headless | reviewer agent + deferred queue ✅ | — | NeverConfirm + Docker | YOLO + Gatekeeper | scoped autonomy | Auto mode | strict | manual+timeout | workspace-write + reviewer | branch isolation |
| Hook system | Pre/Post/PermissionRequest + deny precedence ✅ | ctx.ask() | Pre/Post hooks | — | — | PreToolUse/PermissionRequest | Pre/Post | — | execpolicy | — |
| Subscription scope | routine.allowedPlugins[] (invocation-time) ✅ | session approvals | — | per-tool | per directory | — | path-level | guild allowlist | workspace boundary | per-dir settings |
| Persistent + runtime | settings.json + /permission slash ✅ | session | dynamic | — | — | session | mode switch | /permission cmd | runtime config | settings.json + /yolo /autoApprove |
| Allowed directories | permissions.allowedDirectories[] + auto-suggest ✅ | — | — | — | per directory | additionalDirectories | path-level | — | --cd workspace-write | per-dir settings |
| Path-aware (sensitive) | symlink-resolve + canonicalize + glob ✅ | — | path traversal check | — | — | deny-list | path policy | — | path policy | — |

✅ = LVIS 채택 (이 PR 에서 구현). Issue #627 의 30% → **100%** 달성.

## 5. Phase implementation plan

### Phase 1 — Critical fix-ups (PR #632 in-place) ✅
- C2 trust boundary fix (`resolveInvocationCategory`)
- C3 path traversal regression test
- C4 allowedPlugins=[] deny-all test
- C5 SDK schema host:overlay sync (PR sdk#125 separate)
- C1 6 plugin manifests category 선언 (cross-repo PRs)

### Phase 2 — 6-axis category model
- ToolCategory type widening (`read | write | shell | network`)
- 기존 `dangerous` 사용처 마이그레이션 (bash → shell, agent-spawn → write, ask_user_question → write)
- PermissionManager rules 갱신 (decision matrix Layer 3)
- Manifest validation enum 변경 + missing → fail
- 모든 consumer + test 갱신
- audit 의 `category` field 6-axis

### Phase 2.5 — Allowed directories (Layer 1 + 10)
- `src/permissions/allowed-directories.ts` 작성
- `permissions.allowedDirectories[]` settings 스키마
- Default: cwd + ~/.lvis
- path-bearing tool 의 input path 추출 utility (extractTargetFilePath 강화)
- Auto-suggest heuristic (recent N turns 추적)
- UI: confirm dialog + "디렉토리 영구 추가" 버튼
- Slash: `/permission allow-dir / list-dirs / deny-dir`

### Phase 3 — Reviewer agent (Layer 5, configurable, multi-vendor)
- RiskClassifier interface + 3 구현 (disabled/rule/llm)
- Provider abstraction (Anthropic/OpenAI/Google)
- LLM prompt template + parseVerdict
- Wire into headless write/shell/network path
- Deferred queue (HIGH risk): persist `~/.lvis/permissions/deferred-queue.jsonl`
- Foreground 진입 시 큐 surface
- Settings: `permissions.reviewer.{mode,provider,model,fallbackOnError,thresholds}`
- Tests: rule classifier exhaustive, llm classifier with mock provider

### Phase 4 — Hook system (Layer 6)
- HookRunner extend (Pre 이미 있음 → Post + PermissionRequest)
- Hook discovery (`~/.lvis/hooks/`, settings.json, plugin manifest)
- Hook invocation contract (JSON in/out, exit code semantic)
- Deny precedence enforcement
- Tests: chain order, deny precedence, modify input pass-through

### Phase 5 — /permission slash + audit schema + arch.md
- Slash handler in chat input (Layer 8)
- Mode persistence (settings.json)
- Audit schema 확장 (Layer 7) — 모든 새 필드
- arch.md §6 "Permission Policy" 신규 섹션
- CLAUDE.md "Permission Policy (REQUIRED)" 룰 entry

### Phase 6 — 6 plugin manifests (cross-repo)
- 각 plugin (agent-hub, work-proactive, meeting, local-indexer, ms-graph, lge-api) 의 plugin.json `toolSchemas[*].category` 추가
- 동시 PR 으로 cutover
- lvis-app v5.x SDK 와 lockstep 머지

## 6. Open questions

- **Reviewer agent token cost** — Routine 매번 fire 시 LLM 호출. 일일 limit + caching? 같은 (tool, input shape) 의 verdict caching 으로 token 절감 가능. → Phase 3 에서 추가 설계
- **Hook signing** — `~/.lvis/hooks/*.sh` 가 사용자 시스템 침해 시 우회 도구가 됨. trust check 어떻게? → Phase 4 검토. Claude Code 도 비슷한 trust 가정
- **Plugin sandboxing** — Layer 9 변경 없음으로 가정했지만 capability gating 강화 시 별도 layer 필요 여부 → out-of-scope, future Q13
- **Audit log rotation** — 30일 retention 의 실제 디스크 볼륨 측정 후 결정. Daily rotate?

## 7. Decision log

| 결정 | 사용자 명시 | 출처 |
|---|---|---|
| 6-axis category (built-in/plugin × read/write/shell/network) | ✅ "6-axis" 답변 | 사용자 |
| Reviewer agent multi-vendor + on/off + LLM-free 경로 | ✅ "온오프 가능, 모델 선택 가능" | 사용자 |
| Single Mega PR (PR #632 에 누적 push) | ✅ "Single Mega PR" 답변 | 사용자 |
| Allowed directories layer 추가 | ✅ "디렉토리 지정 따로 취급" | 사용자 |
| Atomic cutover (no fallback shim) | ✅ CLAUDE.md No-Fallback 룰 | repo policy |
| Plugin trust boundary (manifest category only) | ✅ multi-agent critic finding | review |
| 100% 구현 + 이슈 종료 | ✅ "30% 가 아닌 100%" | 사용자 |

## 8. Multi-agent review checklist (다음 단계)

이 설계 문서가 commit + push 되면 다음 reviewer agents 가 cross-check:
- **architect** — 10-layer 설계 정합성, layer 간 contract, deny precedence ordering
- **security-reviewer** — Layer 0/1/3/5/6/10 의 attack vector + bypass 검증
- **code-reviewer** — Phase 별 implementation 가이드의 SOLID + naming + CLAUDE.md 룰
- **critic** — Atomic cutover 의 6 plugin lockstep 가능 여부, reviewer agent token cost 현실성, hook signing 위협 model
- **test-engineer** — 각 layer 의 boundary test 적정 (path traversal, symlink, scope=[], reviewer fallback path)
- **document-specialist** — 10 OSS 레퍼런스 정확성 + 누락 (e.g., Cline, Aider, Devin 등 추가 검토 후 보강)

이 PR 에 commit (1) → 별도 turn 으로 6 reviewer 병렬 dispatch (2) → findings 반영 (3) → Phase 1.5+ 실행 (4) 순.
