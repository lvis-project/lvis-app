# LVIS Phase 2 Track B — Approval Gate + Permissions UI Closure Report

**Status**: ✅ COMPLETE
**Window**: 2026-04-14 → 2026-04-15 (single session continuation)
**Tracks in this phase**: B1 (Unified Approval Gate) + B2 (Permissions Settings Tab)
**Scrapped from original plan**: B3 (Voice Input) — permanently out of LVIS host scope
**Working TODO (root, untracked)**: `TODO.md` §19

---

## 1. Scope Summary

| Item | Status | Evidence |
|---|---|---|
| §6.3 Layer 3 (Tool Permission "ask" user prompt) | ✅ | `ToolApprovalDialog` + `ApprovalGate` round-trip |
| §8 Agent Approval System base (unified with L3) | ✅ | `category: "tool" \| "agent-action"` union in `ApprovalRequest` |
| Blocking per-call modal UX (D1=a) | ✅ | `Dialog` with `onInteractOutside` / `onEscapeKeyDown` gated by `requireExplicit` |
| Persistent rules (`~/.lvis/permissions.json`) | ✅ | `permissions-store.ts` async-mutex + fd-based `0o600` |
| IT-admin managed policy (`~/.lvis/policy.json` `managed: true`) | ✅ | `policy-store.ts` throws on set when managed |
| Permissions Settings tab + rule editor | ✅ | `PermissionsTab` in `SettingsDialog` (new Tabs structure) |
| Inline banner (replaces `alert()`) | ✅ | F9 fix |
| Approval audit (§8 forensic requirement) | ✅ | F7 — 4 phases logged via `AuditLogger` DI |
| IPC input validation hardening | ✅ | F8 — whitelist + type + length checks |
| Fail-closed discipline (missing gate → deny) | ✅ | F4 — `approvalGate` required on `ToolExecutor` construction |

**Intentionally scrapped (user directive 2026-04-14)**: **Voice input / STT → InputCapture** — sidebar mic button, audio directive UX, all voice STT paths to chat. The meeting plugin's transcription STT is a separate product pillar and remains in scope. Permanent feedback memory saved at `memory/feedback_no_voice_input_host.md`.

**Phase 2 proper deferrals** (not in this scope):
- IT Admin API (policy push, signed delivery, `mac-ca`/`win-ca` keystore integration)
- Cross-process file locks (`proper-lockfile`)
- Approval queue UI for parallel tool execution (§4.5.3 activation)
- Governance deny overrides (always-deny list that outranks user allows)
- DLP filter on approval args preview
- Full §8 agent-action callers (Agent Hub `agent_file_share`, `agent_task_delegate`, …)

---

## 2. Implementation Highlights

### 2.1 Unified Approval Gate — §6.3 L3 and §8 share one service

`ApprovalGate` (`src/core/approval-gate.ts`) is a main-process service that:
- Holds `Map<requestId, { resolve, timer }>` for pending user decisions
- `requestAndWait(req)`: awaits user decision via `webContents.send("lvis:approval:request", …)` round-trip
- `resolve(requestId, decision)`: called by the IPC handler when the renderer responds
- 5-minute hard timeout → `deny-once` (fail-safe)
- `disposeAll()`: pending entries get `deny-once` on window teardown

The `ApprovalRequest` type carries `category: "tool" | "agent-action"` — the same modal serves both §6.3 L3 (tool execution ask) and future §8 destructive-action calls. Today only the `tool` entry point is wired; `agent-action` types are present so Phase 2 Agent Hub can call `approvalGate.requestAndWait({ category: "agent-action", … })` without touching this layer.

### 2.2 Managed policy — pattern reuse from Phase 1.5

`policy-store.ts` (`~/.lvis/policy.json`, fields: `requireExplicitApproval: boolean`, `managed: boolean`, `updatedAt`) uses the exact lock pattern copied from `plugin-runtime/registry.ts` (Phase 1.5 F-round F1). When `managed === true`, `savePolicy()` **throws** (converted to `{ ok: false, error: "managed" }` at the IPC boundary). The `PermissionsTab` reads `managed` on mount, disables the checkbox, renders the same `🔒 + bg-muted/40 + yellow helper` pattern as the `PluginDeploymentGuard` UI lock (`renderer.tsx:429-440`) — semantic + visual alignment so users read "this is managed by IT" consistently across features.

**Known limitation (Phase 2 proper)**: `policy.json` lives in user-writable `~/.lvis/`. Same-UID tamper can flip `managed` back. Phase 2 IT Admin API must introduce an admin-dir layer (`/Library/Application Support/LVIS/policy.json` on macOS, `%ProgramData%\LVIS\...` on Windows) that merges ahead of the user-dir, with the admin file owned by root/SYSTEM. This deferral is documented in `policy-store.ts` header.

### 2.3 Fail-closed discipline across every new path

- **ApprovalGate timeout** → `deny-once` (not allow)
- **webContents.send throws** (window destroyed) → `deny-once` + cleanup + audit (F2)
- **`approvalGate` undefined at construction** → `ToolExecutor` throws (F4 required DI)
- **Gate error path in tool-executor** → try/catch → audit + `is_error: true` ToolResult, never skip Step 8 (F3)
- **permissions.json / policy.json write** → `fd = open(0o600)` + `fd.writeFile()` + `fd.close()` (F6)

Every new code path had to justify "what happens if this fails?" before landing. The one exception kept explicitly is the `requireExplicit: false` policy — which changes `onInteractOutside`/`onEscapeKeyDown` to emit `deny-once` on dismiss (still fail-closed — the outcome of a "lenient" UX is still denial, just via a faster path).

### 2.4 Audit as §8 contract

F7 wired `AuditLogger` DI into `ApprovalGate`, logging 4 phases:
1. **requested** — approval dialog sent
2. **decided** — user clicked a button (choice + optional `rememberPattern`)
3. **timeout** — 5 minutes elapsed without decision
4. **send-failed** — dialog couldn't be delivered (window destroyed, serialization throw)

`allow-always` / `deny-always` choices additionally log a "rule-persisted" record when `permissions.json` gets the new entry. This is the minimum needed for §8 forensic replay to distinguish "user clicked allow-always" from "rule was pre-existing".

### 2.5 IPC input validation

F8 added runtime whitelist checks at the IPC boundary (not just TS type casts):
- `set-mode` → `["default", "strict", "auto"]` whitelist
- `policy:set` → rejects `managed` key, type-checks `requireExplicitApproval`
- `add-rule` → pattern non-empty + ≤128 chars, action `"allow" | "deny"`

Renderer can no longer escalate mode to `"auto"` with a crafted IPC — the boundary is actually checked, not assumed.

### 2.6 preload build pipeline — drift root cause fix (F1)

The most important F-round fix. Before: `src/preload.cjs` and `src/preload.ts` both existed; `main.ts` loaded `preload.cjs`; the B1/B2 work to `preload.ts` was compiled but **never loaded at runtime** → `PermissionsTab` would crash on mount, `ToolApprovalDialog` would never receive requests. Unit tests (144/144 green) missed it entirely because nothing exercised the main↔renderer bridge physically.

After: `src/preload.cjs` deleted; `package.json build:preload` esbuild-bundles `preload.ts` → `dist/src/preload.js` (CJS, electron external); `main.ts:107` loads `preload.js` with `existsSync` guard that throws if missing. This establishes `preload.ts` as the single source of truth. Drift re-occurrence is now architecturally prevented (there's no `.cjs` to drift from).

---

## 3. Multi-Agent Validation Round — Architect + Security + Code

Parallel review, pre-F-round.

| Severity | Architect | Security | Code | Total |
|---|---:|---:|---:|---:|
| CRITICAL | 0 | 0 | 0 | **0** |
| HIGH | 3 | 4 | 2 | 9 |
| MED | 3 | 4 | 11 | 18 |
| LOW | 2 | 2 | 3 | 7 |

**Verdicts**: Architect **APPROVE_WITH_MINOR**, Security **CHANGES_REQUIRED**, Code **CHANGES_REQUIRED**.

Test-engineer agent returned a degenerate response (timestamp only); coverage gaps were already surfaced by Code reviewer (C8/C9/C15) so the round proceeded without re-dispatch.

### Top findings

- **S1 HIGH (system-breaking)**: `preload.cjs` is loaded at runtime, stale from Phase 1, does not expose B1/B2 namespaces. B1/B2 **dead on arrival in production**. Unit tests all green — the exact class of bug Phase 1.5 §18 warned about.
- **A1 HIGH**: `ApprovalGate` captures `webContents` at boot, never refreshes on window reload/crash. Pending approvals freeze until 5-min timeout after window replacement.
- **A3 HIGH**: `managed` flag is a single-file soft gate in user-writable `~/.lvis/`. Weaker than Phase 1.5 `PluginDeploymentGuard` path+manifest hybrid.
- **A4 MED**: Parallel tool execution vs single-slot renderer state — batch `ask` decisions silently drop all but first.
- **S2 HIGH**: `writeFile` uses default umask → 0o644. Not matching Phase 1.5 fd-based `fchmod` discipline.
- **S3 HIGH**: Approval decisions not audited. §8 explicit requirement unmet.
- **S7 MED**: IPC inputs not validated on handlers (set-mode, policy:set, add-rule).
- **S10 + C4 HIGH**: `approvalGate` optional → builtin/plugin `ask` silently allowed when gate missing. Fail-open.
- **C1 HIGH**: `webContents.send` throwing leaks pending entries + converts to unhandled rejection.
- **C2 HIGH**: Two `addAlwaysAllowed` variants (sync non-persist vs async persist) = split-brain dead code.
- **C3 MED**: `approvalGate.requestAndWait` reject path escapes Step 8 audit invariant.
- **C12 MED**: `PermissionsTab` uses `alert()` → blocks Electron renderer event loop.

---

## 4. F-Round Fixes — 9/9

| ID | Addresses | Summary |
|---|---|---|
| F1 | S1 (system) | `preload.cjs` 삭제 + esbuild `build:preload` 파이프라인 + `main.ts` existsSync guard. `preload.ts` single source of truth. |
| F2 | C1, C9 | `ApprovalGate` `isDestroyed()` 선검사 + `webContents.send` try/catch → `deny-once` + pending cleanup. |
| F3 | C3 | `tool-executor.ts` `requestAndWait` try/catch → 에러 경로도 `auditToolCall` 호출. |
| F4 | C4, S10 | `ToolExecutor` constructor 에서 `approvalGate` required 승격. fallback ask 결정 fail-closed. |
| F5 | C2, A7 | 죽은 sync `addAlwaysAllowed()` 제거. |
| F6 | S2 | `permissions-store` + `policy-store` 모두 `open(0o600)` + `fd.writeFile` + `fd.close()`. |
| F7 | S3, A5 | `ApprovalGate` 에 `AuditLogger` DI, 4 phase 기록 (requested / decided / timeout / send-failed). `allow-always` 지속화 시 rule-persisted 추가 기록. |
| F8 | S7, A8 | `set-mode` 화이트리스트, `policy:set` `managed` 키 reject + boolean 타입 체크, `add-rule` 패턴 길이/action validation. |
| F9 | C12 | `PermissionsTab` `alert()` → 인라인 배너 (5s auto-dismiss, dismiss button). |

### Phase 2 proper 이월 (주석 또는 후속 PR)

- **A2**: `category: "agent-action"` 실사용자 (§8 Agent Hub callers) 계약 문서화 — `approval-gate.ts` 헤더 JSDoc
- **A3**: admin-dir policy merge path (macOS `/Library/Application Support/LVIS/policy.json`) — `policy-store.ts` 헤더 주석
- **A4**: Parallel tool execution 시 approval queue 승격 — `ToolApprovalDialog` 주석
- **A6**: `setRules` → `setDefaultRules` rename + dynamic `reloadRules()` — 별도 PR
- **S4**: cross-process file lock (`proper-lockfile`) — `permissions-store` / `policy-store` 헤더 주석
- **S5**: governance deny override (`mcp_exec_*`, `shell_*` default deny) — `permission-manager.ts` 주석
- **S6**: approval response HMAC nonce — 주석
- **S8**: `ApprovalGate.pending.size` cap + renderer queue UI — 주석
- **S9**: approval args preview DLP filter — 주석
- **C5~C11**: path normalization, renderer visibility refetch, React effect race — 후속 PR

---

## 5. Testing Results

### 5.1 Unit / Integration (vitest)

**153/153 PASS** across 12 test files (Phase 1 baseline 88 + Phase 1.5 22 + Phase 2B +43).

| Suite | Tests | 성격 |
|---|---:|---|
| Phase 1 / 1.5 existing | 110 | (unchanged) |
| `approval-gate.test.ts` | 8 | request/resolve, timeout, concurrent isolation, send shape, pendingCount, lifecycle guards (F2) |
| `permission-manager.test.ts` | 10 | addAlwaysAllowedPersist, loadRulesFromFile, concurrent writes, removeRule, listPersistedRules, setModePersist |
| `policy-store.test.ts` | 7 | default, roundtrip, managed-locked throw, managed patch ignored, concurrent serialization, 0o600 file mode (F6) |
| `ipc-bridge-permissions.test.ts` | 18 | handler wiring + F8 input validation (set-mode whitelist, policy:set managed/type, add-rule length/action) |

### 5.2 TypeScript

`npx tsc --noEmit`: 0 errors.

### 5.3 Build pipeline (F1 critical check)

- `npm run build:preload` → `dist/src/preload.js` (6.6K) produced
- `dist/src/preload.js` contains `contextBridge.exposeInMainWorld("lvis", { ... })` with `approval.onRequest/respond`, `permission.getMode/setMode/listRules/addRule/removeRule`, `policy.get/set`
- `src/preload.cjs` no longer exists (deleted)
- `dist/src/preload.cjs` stale artifact manually removed post-F-round (housekeeping, not runtime-loaded due to `main.ts` existsSync check for `preload.js` only)
- `main.ts:107` `preloadPath` resolves to `preload.js` with boot-time existsSync throw

### 5.4 Physical E2E gap (still Phase 2 proper)

- **Approval modal end-to-end click-through**: not verified in this session. Requires launching Electron, triggering a `decision === "ask"` tool, clicking each of the 4 buttons, confirming rule persistence. Defer to QA or explicit user physical run.
- **`~/.lvis/policy.json` managed lock**: not physically tested. User can verify by manually editing `policy.json` with `"managed": true` and checking that the Permissions tab's checkbox disables + 🔒 appears.

---

## 6. Commit Trail

To be filled after user authorization:

| Commit | Repo | Summary |
|---|---|---|
| (pending) | lvis-app | Phase 2 Track B: Approval Gate + Permissions UI (B1+B2+F-round 9) |
| (pending) | (root) | TODO.md §19 + voice-input scope removal |

---

## 7. Architectural Decisions Log

### 7.1 Why unify §6.3 Layer 3 with §8 Agent Approval?

Both are "pause, ask the user via modal, block until decision" semantics. Splitting them would duplicate the modal, the IPC round-trip, the queue, and the audit. The cost of one `category` discriminator field is 1 line of TypeScript — vs. dozens of lines of parallel plumbing that would drift apart. Unification is free and compounds forward: when §8 agent-action callers land, they call the same `ApprovalGate.requestAndWait` with `category: "agent-action"` and reuse every safety property (fail-closed, audit, timeout, rule persistence).

### 7.2 Why blocking per-call modal (D1=a) over queue UX?

Queue UX is tempting (batch approval for long agentic loops) but introduces a real architectural question: does the LLM turn halt while the user works through the queue, or continue opportunistically? Answering that correctly requires rethinking `ConversationLoop` control flow. Phase 2 Track B deliberately chose the simpler semantic (blocking per-call) because:
- It matches §6.3 L3 spec literally
- It gives each tool call an explicit user audit trail (not "approved in batch")
- Parallel tool execution is not yet activated in LVIS (§4.5.3 is future work)
- The "approval fatigue" downside is mitigated by `allow-always` persistence

When parallel execution lands, Phase 2 proper will add an approval queue UI. The ApprovalGate itself already supports concurrent pending requests — only the renderer's single-slot `useState<ApprovalRequest | null>` is limiting (flagged by A4).

### 7.3 Why persist rules to `~/.lvis/permissions.json` vs session-only?

Session-only forces users to re-approve the same tool every startup → approval fatigue → users train themselves to click "always allow" carelessly → permission model neutered. Persistence + UI-editable rule list preserves the decision across sessions AND makes it auditable/reversible. The lock pattern ensures TOCTOU safety even when Phase 2's ManagedPolicySync lands.

### 7.4 Why `managed: boolean` single-file (not hybrid)?

Pragmatic Phase 1 shape. The Phase 1.5 deployment guard uses hybrid (path + manifest field) because bundled plugins live inside `plugins/installed/` with the same parent as user plugins — the ambiguity required hybrid check. Policy does not have this ambiguity: there's one policy file, owned by the host. Adding hybrid now would be premature; adding admin-dir merge later (Phase 2 proper A3) is a clean linear extension. The architect agent flagged this as HIGH because naming alignment with Phase 1.5 `managed` can mislead readers into expecting the same enforcement strength — closure report §2.2 documents the gap explicitly to prevent that misread.

### 7.5 Why `approvalGate: required` in `ToolExecutor` (no optional fallback)?

The optional parameter was a phase-in gradient from Phase 1 that outlived its purpose. Every F-round fix had to decide "what does this branch do when gate is missing?" and every safe answer was "deny". If every safe answer is deny, the branch shouldn't exist. Making the parameter required collapses 10 lines of fallback code and eliminates a class of latent fail-open bugs. The tradeoff: any test that constructs `ToolExecutor` standalone must now wire an `ApprovalGate` or a mock. Acceptable cost for eliminating the fail-open gradient.

### 7.6 Why `preload.ts` as single source of truth (delete `preload.cjs`)?

`preload.cjs` + `preload.ts` coexistence was a leftover from a previous ESM/CJS migration. It passed every unit test because no test exercised the physical `BrowserWindow` preload load path — exactly the kind of "physical cold boot" gap Phase 1.5 §18 already identified. S1's existence proves the gap still exists. Collapsing to one file with `main.ts` existsSync guard eliminates the drift class permanently.

---

## 8. Systemic TODO

### 8.1 Preload physical load path not exercised by unit tests

S1 was found only because a security reviewer manually traced the file that `main.ts` loads vs the file that Phase 2 Track B edited. Unit tests imported `preload.ts` directly — fine for TS contract checks, useless for runtime load path. Phase 2 proper should add a `scripts/smoke-preload.mjs` that spawns Electron, loads a test page, and asserts `window.lvis.approval` is a function. Or: a minimal E2E via Playwright-electron.

Until that lands, the F1 fix's `existsSync` guard is the best we have — it catches "preload.js missing" but not "preload.js doesn't expose what renderer expects."

### 8.2 Voice input feedback memory

`/Users/ken/.claude/projects/-Users-ken-workspace-GIT-github-lvis-project/memory/feedback_no_voice_input_host.md` saved 2026-04-14. Future sessions will not re-propose voice STT for chat input. Meeting plugin STT (transcription) remains in scope and is explicitly excepted.

### 8.3 OpenAI API key rotation (carried from Phase 1.5 §8.2)

Not addressed in this phase. User's responsibility.

### 8.4 Physical approval modal click-through verification

This session covered code correctness + unit tests + build pipeline. A physical run of the approval dialog was not performed. The F1 fix makes the modal loadable; a human QA pass (or Playwright-electron automation in Phase 2 proper) should verify:
1. Triggering a `strict` mode tool call produces a visible dialog
2. Each of 4 buttons produces the expected tool result + audit entry
3. `allow-always` adds a rule visible in the Permissions tab
4. Switching `policy.json` to `managed: true` disables the checkbox with lock UI

### 8.5 Test-engineer agent degradation

The `test-engineer` reviewer returned only a timestamp in B4. Coverage gaps were covered by code reviewer, so no blocker, but the reviewer pipeline should be investigated (why did it return empty?). Action: post-phase, inspect the test-engineer agent prompt/template for brittleness.

---

## 9. References

- `docs/architecture/architecture.md` §6.3 (Tool Permission Model 3-layer), §8 (Agent Approval System), §4.5.6 (Tool execution pipeline)
- `docs/architecture/plugin-deployment-model.md` — Phase 1.5 `managed` precedent
- `docs/blueprints/phase1.5-closure-report.md` — prior phase (F-round pattern, fd-based chmod discipline, preload gap prefigured in §18)
- `TODO.md` (root, untracked) §19 — Phase 2 Track B working state
- Memory: `feedback_no_voice_input_host.md` — permanent voice input out-of-scope directive

---

**작성자**: Claude Opus 4.6 (LVIS 오토파일럿 세션)
**작성일**: 2026-04-15 KST
**다음 단계**: Phase 2 proper — IT Admin API (policy push + signed delivery), §17 `mac-ca`/`win-ca` OS keystore, §8 Agent Hub callers using this gate, parallel tool execution + approval queue UI. §16.2 5 결정 항목 IT 부서 협의 선행 필요.
