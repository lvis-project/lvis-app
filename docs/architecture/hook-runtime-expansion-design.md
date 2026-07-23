# Hook Runtime Expansion — Design

> Status: **milestone-1 + milestone-2 IMPLEMENTED on `dev`** (2026-06-06) · Issue: [#811](https://github.com/lvis-project/lvis-app/issues/811)
> DONE + cluster-reviewed: command hooks (declarative `hooks.json` via TOFU trust),
> the `mcp_*` tool matcher, per-request MCP identity in hook stdin, and ALL §5
> lifecycle events — 6 non-blocking observe-only (PostToolUseFailure, PermissionDenied,
> SessionStart, Stop, PreCompact, PostCompact) + 1 blocking fail-closed
> (UserPromptSubmit). GATED milestones remain design-only, tracked as issues:
> HTTP hooks (§6.3 → #1235); context-altering MCP/prompt/agent hooks + input
> mutation (§6.4/§6.5 → #1236) — each needs its security control (host allowlist /
> hook signing) FIRST.
> Companion (to be added): `hook-runtime-reference-review.md` (full Codex / Claude Code /
> OpenCode / Kilo Code / Warp / Hermes comparison).

LVIS's external hook runtime is intentionally narrow: three shell-script events with a
hash-locked, quarantine-by-default trust model. This document designs how to **expand
compatibility** (generic command hooks, more lifecycle events, eventually HTTP / MCP /
prompt / agent hooks) **without weakening that trust posture**. Every expansion is gated
behind a phase that adds the security control it depends on first.

---

## 1. Current state (verified against code)

### 1.1 The three hook events

| Event | File pattern | Fire point (`file:line`) | Blocking semantics |
|---|---|---|---|
| `PreToolUse` | `pre-*.sh` | `src/tools/invocation-execution.ts:147` (step 4, after Layer-3 permission resolves, before execute) | **deny → tool blocked** |
| `PostToolUse` | `post-*.sh` | `src/tools/invocation-execution.ts:498` (step 7, after execute; receives `toolOutput` + `isError`) | **informational only** (tool already ran) |
| `PermissionRequest` | `perm-*.sh` | `src/tools/invocation-authorization.ts:427/465/814/931` (ask-path gates, before `approvalGate.requestAndWait()`) | **deny → ask+execute blocked** |

Discovery: `src/hooks/hook-discovery.ts` resolves `~/.config/lvis/hooks/`, globs `pre-|post-|perm-` prefix + `.sh` suffix (`hookTypeFromName`, line 115), skips dotfiles and `.disabled/`, returns a sorted `DiscoveredHook[]` of `{ fileName, path, hookType, sha256, size }`.

### 1.2 Trust / quarantine (the part we must preserve)

- **Hash lockfile** `~/.config/lvis/hooks/.lockfile.json` (`LockfileShape`, `src/hooks/hook-discovery.ts:68`): `{ schemaVersion, updatedAt, hooks: { fileName, sha256, acceptedAt }[] }`. States: `new` / `changed` / `trusted` / `removed` via `diffAgainstLockfile` (line 202).
- **Quarantine by default**: at boot `runHookTrustWorkflow` (`src/hooks/hook-trust-prompt.ts:81`) moves every `new`/`changed` hook to `.disabled/` (`disableHook`, `src/hooks/hook-discovery.ts:285`). **No renderer prompt in production** — strict-deny.
- **TOFU enrollment**: `/permission hooks accept <name>` (`src/hooks/hook-trust-commands.ts:138`) restores from `.disabled/` and records the current sha256. Per CLAUDE.md §Permission Policy this dispatches only for `trustOrigin === "user-keyboard"`.
- **Quarantine audit**: `emitHookQuarantineAudit` (`src/boot/steps/hook-system-wiring.ts:80`) → `kind: "hook.quarantined"` + `appendPermissionAuditEntry`.

### 1.3 Execution model

- **Runner**: `src/hooks/script-hook-runner.ts:runOneHookScript`. Input = single-line JSON on **stdin** (`ScriptHookStdin`); output = stdout JSON (`ScriptHookStdout = { action: "allow"|"deny", reason }`).
- **Timeout**: `DEFAULT_HOOK_TIMEOUT_MS = 5_000` (`src/hooks/script-hook-types.ts:103`) — **separate** from `TOOL_TIMEOUT_POLICY`'s 120 s global ceiling. Enforced via `SIGKILL` of the detached process group.
- **Env allowlist**: `buildSafeChildEnv` (`src/tools/safe-env.ts`) forwards only a generic non-secret allowlist (`FORWARD_ENV_KEYS`: `PATH`, `HOME`, `USER`, `USERNAME`, `LANG`, `LC_*`, `TZ`, …) plus the three injected `LVIS_HOOK_TYPE` / `LVIS_HOOK_TOOL_NAME` / `LVIS_HOOK_TRUST_ORIGIN` vars. Everything else — `LVIS_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_*`, `AWS_*`, `GITHUB_TOKEN`, future provider secrets — is stripped.
- **Fail-closed**: non-zero exit, timeout, spawn error, or malformed stdout → **deny**.
- **Composition**: deny precedence — a hook may downgrade an upstream `allow` to `deny`, never upgrade `deny` to `allow`. **No `modify`/`updatedInput` action exists in v1** (deferred pending signing).
- **DLP**: `input` strings are DLP-redacted at the caller (`src/hooks/script-hook-manager.ts`) before dispatch.

### 1.4 What `src/hooks/post-turn-hook-chain.ts` is (and is NOT)

`PostTurnHookChain` is an **internal, hardcoded** pipeline (mark-stale → checkpoint → saveSession → extractMemory → title → audit → todo → idle-poke) that runs after `queryLoop` resolves. It is **not** a user-script hook surface. The new `Stop` / `PostCompact` lifecycle events (below) are conceptually adjacent but are a **distinct, user-facing** surface — the design keeps them separate and never lets a user hook block the internal persistence chain.

### 1.5 Audit shape today

`src/audit/audit-schema.ts:HookResult = { hookName, hookType: "pre"|"post"|"perm", action, reason, durationMs }`, carried in `AuditAllow/Ask/Deny.hookChain[]`. This shape is **too narrow** for the expansion (no event surface beyond the 3, no handler type, no command identity, no matcher) — §7 extends it.

---

## 2. Reference comparison (condensed)

| System | Handler types | Events beyond tool-use | Security controls |
|---|---|---|---|
| **LVIS (today)** | `.sh` only | none | hash lockfile, quarantine, strict-deny, fail-closed, env allowlist |
| Codex | generic `type: "command"` | config-driven | `/hooks` review, managed hook policy |
| Claude Code | command, HTTP, MCP-tool, prompt, agent | session/prompt/stop/compact lifecycle | `/hooks`, managed-only mode, URL/env allowlists, timeouts |
| OpenCode / Kilo | JS/TS plugin hooks | plugin lifecycle | plugin trust + load policy |
| Warp | delegates to integrated agent | — | delegated |
| Hermes | Python gateway/plugin hooks | gateway lifecycle | gateway policy |

**Takeaway**: the highest-value, lowest-risk increment is **generic `command` hooks + a richer lifecycle event surface** (Codex parity). HTTP / MCP / prompt / agent hooks (Claude-Code parity) carry exfiltration and context-manipulation risk and must wait for the controls in §6.3–§6.4.

---

## 3. Goals / non-goals

**Goals**
- Backward-compatible: existing `pre-*.sh` / `post-*.sh` / `perm-*.sh` keep working unchanged as the v1 compatibility layer.
- A single internal **hook registry** that can represent both legacy `.sh` files and new generic command hooks.
- Generic `command` hooks (Python / Node / shell / binary) with explicit `event` + `matcher` + `timeoutMs`.
- A broader, well-defined **lifecycle event surface** mapped to concrete fire points.
- Preserve strict trust: hash-trust, quarantine-by-default, fail-closed, env allowlist, user-keyboard-only enrollment, trust-review visibility.

**Non-goals (this phase)**
- Input mutation (`updatedInput` / `modify`) — deferred until hook signing or managed policy exists (§6.5).
- HTTP / MCP-tool / prompt / agent hooks — later gated milestones, behind new controls.
- Replacing the internal `post-turn-hook-chain`.

---

## 4. Hook registry + config schema

### 4.1 Unified internal registry

Introduce an internal `HookRegistry` that merges two sources into one normalized list:

1. **Legacy** `.sh` files (discovered exactly as today) → synthesized registry entries with `handler.type = "command"`, `handler.command = <abs .sh path>`, `event` derived from the `pre-|post-|perm-` prefix, `matcher = "*"`.
2. **Declarative** entries from `~/.config/lvis/hooks/hooks.json` (new).

Normalization means every downstream consumer (trust diff, runner, audit, trust-review UI) sees one entry shape regardless of origin.

### 4.2 Declarative config (`hooks.json`)

```jsonc
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|apply_patch|mcp__.*",   // regex over toolName; "*" = all
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.config/lvis/hooks/pre_tool_policy.py",
            "timeoutMs": 5000                       // clamped to the hook ceiling, §6.2
          }
        ]
      }
    ]
  }
}
```

- `event` keys are the closed set in §5. Unknown events → entry ignored + warn-audited (fail-closed, never silently active).
- `matcher` is a regex matched against the event's primary subject (`toolName` for tool events; empty/`*` for lifecycle events).
- Each `handler` declares `type` (initially only `"command"`), `command` (argv string), and optional `timeoutMs`.
- **Trust identity** of a `command` handler = the sha256 of the resolved local script/executable when the command resolves to a local file (see §6.1); plus the verbatim `command` string. Both are shown in the trust-review UI and recorded in the lockfile.

### 4.3 Backward compatibility

- If `hooks.json` is absent, behavior is byte-identical to today.
- A legacy `.sh` and a declarative entry can coexist; ordering is: legacy `.sh` (alphabetical) then declarative (file order), with deny-precedence composition unchanged.

---

## 5. Lifecycle event surface

Each proposed event below has a **verified existing fire point**. `Blocking` states whether a `deny` can stop the flow (and therefore whether the event is fail-closed).

| Event | Fire point (`file:line`) | Subject for `matcher` | Blocking | Context payload (additions to base) |
|---|---|---|---|---|
| `PreToolUse` *(existing)* | `src/tools/invocation-execution.ts:147` | `toolName` | **yes** | `input`, `source`, `category` |
| `PostToolUse` *(existing)* | `src/tools/invocation-execution.ts:498` | `toolName` | no | `toolOutput`, `isError` |
| `PermissionRequest` *(existing)* | `src/tools/invocation-authorization.ts:427/465/814/931` | `toolName` | **yes** | `input`, permission verdict |
| `PostToolUseFailure` | `src/tools/invocation-execution.ts:520` (execute returned `isError`) | `toolName` | no | `errorMessage`, `durationMs` |
| `PermissionDenied` | `src/tools/pipeline/audit-writer.ts:191` (all denied terminal audits) | `toolName` | no (observe) | `denyReason { layer, source }` |
| `UserPromptSubmit` | `src/engine/turn/run-turn.ts:183` (after classify/route, before `queryLoop`) | input text | **yes** (deny → turn refused) | `inputText`*, `inputOrigin`, `route`, `classification` |
| `SessionStart` | `src/engine/turn/run-turn.ts:169` (`runTurn` entry) | sessionId | no | `sessionMeta` (routine scope / persona) |
| `Stop` | `src/engine/turn/run-turn.ts:430` (`runTurn` finally, before post-turn chain) | sessionId | no | `stopReason`, `toolCount`, `durationMs` |
| `PreCompact` | `src/engine/turn/compaction.ts:81/442` (manual/automatic paths) | sessionId | no | `reason` (threshold/manual), `tokenEstimate` |
| `PostCompact` | `src/engine/turn/compaction.ts:118/488` (manual/automatic paths) | sessionId | no | `messagesBefore/After`, `tokensBefore/After` |

\* `UserPromptSubmit` `inputText` and any tool `input` are **DLP-redacted** before dispatch (§6.6). `UserPromptSubmit` is the only **new** blocking event; it must inherit the same fail-closed semantics as `PreToolUse`.

**Design rules for new events**
- Blocking events (`UserPromptSubmit`) are fail-closed: timeout/error/malformed → deny.
- Non-blocking events never affect control flow; their `deny` is recorded as a policy signal in audit only (mirrors `PostToolUse`).
- Lifecycle events fire **after** trust resolution; quarantined hooks never fire.
- No event passes secrets in env or payload; the env allowlist (§6.2) is unchanged.

---

## 6. Security model

### 6.1 Trust for `command` handlers
- When `command`'s argv[0]/script path resolves to a **local file**, its sha256 is the trust identity (same lockfile mechanism as `.sh`). A changed script → `changed` → re-quarantined.
- When it resolves to a **PATH binary** (e.g. `python3`), trust is keyed on the **verbatim command string** plus the sha256 of any local script argument it references. A pure-binary command with no local script (e.g. `curl ...`) is treated as **higher-risk** and is **not permitted in the command-hooks milestone** (it has no stable local hash to anchor trust) — such commands wait for managed/signed policy.
- All new/changed hooks (legacy or declarative) are quarantined by default; enrollment is user-keyboard-only via `/permission hooks accept <name>`.

### 6.2 Timeouts & environment
- Per-handler `timeoutMs` is clamped to a hook ceiling (`DEFAULT_HOOK_TIMEOUT_MS`, raised to an explicit `HOOK_TIMEOUT_CEILING_MS` SOT if needed). Hooks remain on their **own** budget, independent of `TOOL_TIMEOUT_POLICY`. Document both ceilings so they don't drift.
- Env allowlist is unchanged and extended only with event-specific non-secret vars (`LVIS_HOOK_EVENT`, `LVIS_HOOK_MATCHER`). Secrets never pass through.

### 6.3 HTTP hooks (gated milestone)
- Not allowed until a URL/host allowlist + method + body-size + timeout + redirect policy exists. HTTP hooks are an **exfiltration surface**; the design requires an explicit allowlist (no wildcard hosts) and audit of every request target before they ship.

### 6.4 MCP-tool / prompt / agent hooks (gated milestone)
- These can **alter model context or decisions**, so they ship only after (a) signed or managed-only hook policy and (b) **model-visible audit** (the model/user can see that a hook influenced context). Until then they are out of scope.

### 6.5 No input mutation until signing
- v1 keeps `action ∈ { allow, deny }`. `updatedInput`/`modify` is withheld until hook signing or managed policy — a mutating hook is a far larger trust delegation than a deny-only gate.

### 6.6 DLP & trustOrigin
- Every payload string that could carry user/secret data (`input`, `toolOutput`, `inputText`) is DLP-redacted at the caller before dispatch, exactly as today.
- `trustOrigin` is propagated into every event payload; non-user-origin inputs can never enroll or mutate hooks.

---

## 7. Audit schema extension

Replace the narrow `HookResult` with a forward-compatible record (old rows remain readable — new fields optional):

```ts
interface HookExecutionAudit {
  hookName: string;
  event: HookEvent;              // closed set from §5 (was: hookType pre|post|perm)
  matcher: string;               // the configured matcher
  handlerType: "command";        // "http" | "mcp" | "prompt" | "agent" in later phases
  commandIdentity: string;       // resolved script sha256, or hash(command string)
  decision: "allow" | "deny" | "observe";   // "observe" for non-blocking events
  reason: string;
  durationMs: number;
  failureReason?: "timeout" | "nonzero-exit" | "spawn-error" | "bad-output";
}
```

Audit must capture, per the acceptance criteria: **event, matcher, handler type, command identity, decision, duration, and failure reason**. `hookType: pre|post|perm` is retained as a derived alias for back-compat readers.

---

## 8. Rollout milestones

Each milestone is gated on the security control it depends on; names are
behavior-based, not sequence numbers.

| Milestone | Delivers | Gate (must exist first) |
|---|---|---|
| **Command hooks** | `hooks.json` + unified registry + generic `command` hooks for the existing 3 events; trust-review UI shows command/source/event/matcher/timeout; audit extension (§7) | none (builds on current trust model) |
| **Lifecycle events** | `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `PostToolUseFailure`, `PermissionDenied` at the §5 fire points | command-hooks registry + audit |
| **HTTP hooks** | HTTP handler type | URL/host allowlist + method/body/timeout/redirect policy (§6.3) |
| **Remote & context hooks** | MCP-tool / prompt / agent handler types | signed/managed policy + model-visible audit (§6.4) |

### Acceptance criteria → design mapping (command-hooks milestone)
- *Documented command-hook schema* → §4.2.
- *`.sh` backward compatibility* → §4.1 (legacy synthesized into the registry), §4.3.
- *Run Python/Node/shell/binary* → §4.2 `command` argv; §6.1 trust constraint for binary-only commands.
- *New/changed hooks visible in trust review, cannot silently run* → §6.1 quarantine-by-default + trust-review fields.
- *Audit records event/matcher/handler/command identity/decision/duration/failure* → §7.
- *Unit tests: discovery, trust diff, command execution, timeout, invalid output, deny precedence, `.sh` back-compat* → test plan §9.

## 9. Test plan (command-hooks milestone)
- **Discovery/normalization**: `.sh` + `hooks.json` merge into one registry; unknown event ignored+warned; matcher regex compiled safely (reject catastrophic patterns).
- **Trust diff**: new/changed `command` script quarantined; `/permission hooks accept` restores; binary-only command rejected up front.
- **Execution**: command runs Python/Node/shell; stdin payload shape; stdout `allow`/`deny`; non-zero exit / timeout / malformed → deny; env allowlist enforced (secret vars absent).
- **Composition**: deny precedence across legacy + declarative; cannot upgrade deny→allow.
- **Back-compat**: with no `hooks.json`, behavior byte-identical to today.

## 10. Open decisions
1. **`hooks.json` trust unit**: per-file (whole config) vs per-entry hashing. Per-entry is finer-grained for trust review but more lockfile churn. *Recommendation: hash the whole `hooks.json` as one trust unit (mirrors a single `.sh` file) plus the sha256 of each referenced local script.*
2. **`UserPromptSubmit` blocking**: should a deny refuse the turn outright, or strip/annotate the prompt? *Recommendation: deny = refuse turn (fail-closed); annotation requires the deferred `modify` capability.*
3. **Hook ceiling vs tool ceiling**: keep the 5 s hook budget, or a separate raised ceiling for command hooks that shell out to interpreters? *Recommendation: keep 5 s default; add an explicit per-handler `timeoutMs` clamped to a documented `HOOK_TIMEOUT_CEILING_MS` SOT.*
4. **Managed policy**: do enterprise deployments get a managed `hooks.json` (admin-pushed, non-removable) analogous to admin-policy plugins? Likely yes in a later phase; out of scope here.
