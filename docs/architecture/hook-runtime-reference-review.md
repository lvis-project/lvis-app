# Hook Runtime Reference Review

**Status**: Research note
**Last Updated**: 2026-05-16
**Scope**: LVIS hook runtime vs. Codex, Claude Code, OpenCode, Kilo Code, Warp, Hermes Agent

---

## 1. Executive Summary

LVIS currently runs production external hooks only as shell script files under
`~/.config/lvis/hooks/`.

The accepted file shapes are:

| LVIS file shape | Event equivalent | Current effect |
| --- | --- | --- |
| `pre-*.sh` | `PreToolUse` | May deny before execution |
| `post-*.sh` | `PostToolUse` | Observes after execution; cannot undo side effects |
| `perm-*.sh` | `PermissionRequest` | May deny before an approval prompt is shown |

This is narrower than the reference systems:

| System | External hook execution model | Notes |
| --- | --- | --- |
| LVIS | `.sh` files only, shell subprocess | Strong trust/quarantine model, limited compatibility |
| Codex | Generic `command` hook from config | Python, Node, shell, and binaries can be launched through command strings |
| Claude Code | `command`, HTTP, MCP tool, prompt, agent | Broadest surface; relies on settings policy and trust review |
| OpenCode | JS/TS plugin hooks | In-process plugin extensibility |
| Kilo Code | JS/TS plugin hooks | Similar to OpenCode, with mutation hooks for chat/tool/provider flows |
| Warp | Third-party CLI agent integration | Delegates hook behavior to integrated tools such as Claude/Codex/OpenCode |
| Hermes Agent | Python gateway/plugin hooks and shell hooks | Separates Python hook systems from shell hooks |

LVIS's current model is intentionally conservative: hook discovery is file based,
hash locked, strict-deny on unknown or changed files, and fail-closed on runtime
errors. The tradeoff is lower ecosystem compatibility and no support for
generic command, HTTP, MCP-tool, prompt, or agent hooks.

---

## 2. LVIS Current Behavior

### 2.1 Production external hook discovery

Evidence:

- `src/hooks/hook-discovery.ts` rejects every hook file whose extension is not `.sh`.
- The same parser only maps `pre-`, `post-`, and `perm-` filename prefixes to hook types.
- `src/boot/conversation.ts` explicitly states that legacy `hooks.json` command/http loading is not wired at boot because it bypasses the quarantine/accept flow.

Current implication:

LVIS does not run `.py`, `.js`, `.mjs`, arbitrary binaries, HTTP hooks, MCP hooks,
prompt hooks, or agent hooks through the production external hook path.

### 2.2 Production external hook execution

Evidence:

- `src/hooks/script-hook-runner.ts` resolves a shell and runs the discovered hook file path through that shell.
- The hook receives JSON on stdin and returns JSON on stdout.
- Runtime failure semantics are fail-closed:
  - non-zero exit -> deny
  - timeout -> deny
  - invalid stdout JSON -> deny

Current stdout contract:

```json
{
  "action": "allow",
  "reason": "human-readable reason"
}
```

Only `allow` and `deny` are supported. `modify` is deliberately deferred until a
future hook-signing model exists.

### 2.3 Internal hook runner

`src/hooks/hook-runner.ts` still provides an in-process TypeScript hook API:

- `registerPreHook`
- `registerPostHook`
- `registerFailureHook`

This is not the production external hook mechanism. It is used internally and in
tests, and it does not replace the `~/.config/lvis/hooks/*.sh` trust path.

### 2.4 Plugin event subscriptions

Plugin code can subscribe to host events through HostApi, for example
`context.hostApi.onEvent(...)` and `context.hostApi.onPluginsChanged(...)`.
This is an event bus/plugin runtime capability, not the same thing as the
external lifecycle hook system.

### 2.5 LVIS current security posture

| Area | Current behavior | Security property | Compatibility cost |
| --- | --- | --- | --- |
| Discovery | Only `pre/post/perm-*.sh` | Small executable surface | No generic command hooks |
| Trust | Hash lockfile under hooks dir | Changed/new hooks require explicit trust path | More friction for package-managed hooks |
| Quarantine | Unknown/changed files move to `.disabled/` | Default-deny on supply-chain drift | Surprise disable if tooling updates hook file |
| Runtime failure | Non-zero, timeout, parse failure -> deny | Fail-closed | Hook bugs can block tool use |
| Output contract | `allow` or `deny` only | No silent mutation | No `updatedInput`, context injection, or response filtering |
| Environment | Allowlisted hook env | Avoids broad secret leakage | Hooks need explicit data in stdin/env |

---

## 3. Reference Systems

### 3.1 Codex

Codex discovers hooks from `hooks.json` or inline `[hooks]` tables in
`config.toml`.

Hook structure:

- event
- matcher group
- handler list

Currently executed handler type:

- `type: "command"`

Important limitation:

Codex documentation says `prompt` and `agent` handlers are parsed but skipped
today. HTTP hook handlers are not part of the current documented runtime.

Security model:

- Non-managed command hooks must be reviewed and trusted before they run.
- `/hooks` lets users inspect hook sources, review new or changed hooks, trust hooks, or disable individual non-managed hooks.
- Managed hooks from system, MDM, cloud, or `requirements.toml` are trusted by policy and cannot be disabled from the user hook browser.
- Managed hooks can be enforced through `requirements.toml`, with scripts distributed separately by enterprise tooling.

Assessment:

Codex does not appear to perform semantic malware detection on hook commands.
The primary control is source/config trust review plus managed policy.

Source:

- https://developers.openai.com/codex/hooks

### 3.2 Claude Code

Claude Code supports a much broader hook handler surface.

Handler styles include:

- command
- HTTP
- MCP tool
- prompt
- agent

Security controls observed in documentation:

- Users can inspect configured hooks through `/hooks`.
- `disableAllHooks` can disable hooks.
- `allowManagedHooksOnly` can restrict hook loading to managed/SDK/enabled plugin hooks.
- HTTP hooks can be constrained through URL allowlists such as `allowedHttpHookUrls`.
- HTTP hook secret/header interpolation can be constrained by allowed environment variable settings.
- Timeout and error behavior are part of the hook execution contract.

Assessment:

Claude Code provides structural policy gates for HTTP and managed hook loading,
but the documentation does not indicate a general semantic detector that decides
whether an HTTP or agent hook is safe. Trust is primarily user/admin policy,
allowlist, managed-only mode, and runtime bounds.

Source:

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/settings

### 3.3 OpenCode

OpenCode uses plugin hooks rather than a Claude/Codex-style external hook file
runtime.

Typical model:

- JavaScript/TypeScript plugin modules are loaded by OpenCode.
- Plugins return hook functions keyed by events.
- Events include tool execution, permission, session, message, file, shell env,
  and compaction-related lifecycle surfaces.

Assessment:

OpenCode's model is closer to in-process plugin extensibility. Security depends
on plugin installation trust, plugin source, and the host's plugin loading
policy, rather than on per-script shell quarantine.

Source:

- https://opencode.ai/docs/plugins/

### 3.4 Kilo Code

Kilo Code exposes plugin hooks in a model similar to OpenCode.

Typical model:

- `.ts` or `.js` plugin modules are loaded from plugin locations or packages.
- Hooks can inspect or mutate tool args, output, chat parameters, command
  execution, shell environment, and provider/auth surfaces.

Assessment:

This provides richer extension power than LVIS's current `.sh` contract, but it
also expands the trusted code surface. A direct LVIS port would need a plugin
trust boundary and managed policy before enabling arbitrary JavaScript hooks.

Source:

- https://kilo.ai/docs/automate/extending/plugins

### 3.5 Warp

Warp documents CLI agent integration and third-party agent support. The relevant
model is integration with agents such as Claude Code, Codex, and OpenCode rather
than a broad native hook runtime equivalent to Claude Code.

Assessment:

Warp is useful as an integration reference for how third-party agent runtimes
are surfaced to the user, but not as the main reference for LVIS hook execution
semantics.

Source:

- https://docs.warp.dev/agent-platform/cli-agents/overview/

### 3.6 Hermes Agent

Hermes Agent has three hook styles:

- Gateway hooks configured with `HOOK.yaml` and Python handlers.
- Plugin hooks registered from Python plugins.
- Shell hooks configured as commands.

Observed lifecycle surfaces include:

- `pre_tool_call`
- `post_tool_call`
- `pre_llm_call`
- `post_llm_call`
- session start/end
- subagent stop

Assessment:

Hermes is a useful reference for separating Python plugin hooks from shell
hooks, and for adding LLM-call hooks. Its model is more permissive than LVIS's
current `.sh`-only production path.

Source:

- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md

---

## 4. Event Surface Comparison

| Event family | LVIS current | Codex | Claude Code | OpenCode / Kilo | Hermes Agent |
| --- | --- | --- | --- | --- | --- |
| Session start | No external hook | `SessionStart` | `SessionStart`, `Setup` | `session.*` | session start |
| User prompt submit | No external hook | `UserPromptSubmit` | `UserPromptSubmit`, prompt expansion | message/chat hooks | pre LLM call |
| Pre tool use | `pre-*.sh` | `PreToolUse` | `PreToolUse` | `tool.execute.before` | `pre_tool_call` |
| Permission request | `perm-*.sh` | `PermissionRequest` | `PermissionRequest` | `permission.*` | implementation-specific |
| Permission denied | No external hook | Not primary documented surface | `PermissionDenied` | permission reply hooks | implementation-specific |
| Post tool use | `post-*.sh` | `PostToolUse` | `PostToolUse`, failure/batch variants | `tool.execute.after` | `post_tool_call` |
| Stop/end turn | No external hook | `Stop` | `Stop`, `StopFailure`, `SessionEnd` | session/message lifecycle | session end |
| Compact | Internal post-turn/preflight only | Noted in hook docs | `PreCompact`, `PostCompact` | experimental compaction hooks | implementation-specific |
| Agent/subagent | No external hook | parsed but skipped today | agent/subagent lifecycle hooks | plugin-specific | `subagent_stop` |
| HTTP hook | No | Not current documented runtime | Yes | Not primary hook style | Shell/plugin can call HTTP |

---

## 5. Handler Type Comparison

| Handler type | LVIS current | Codex | Claude Code | OpenCode / Kilo | Recommended LVIS phase |
| --- | --- | --- | --- | --- | --- |
| Shell file | Yes, `.sh` only | Via `command` | Via `command` | Not primary | Keep as v1 compatibility |
| Generic command | No | Yes | Yes | Not primary | Phase 1 |
| JavaScript/TypeScript plugin hook | Internal/plugin event bus only | No | Plugin-dependent | Yes | Separate plugin-governance track |
| HTTP hook | No | No current documented runtime | Yes | Not primary | Phase 3+ only |
| MCP tool hook | No | No current documented runtime | Yes | Not primary | Phase 3+ only |
| Prompt hook | No | Parsed but skipped | Yes | Chat/message hook equivalents | Phase 4+ only |
| Agent hook | No | Parsed but skipped | Yes | Plugin-specific | Phase 4+ only |

---

## 6. Security Comparison

| System | Execution model | Primary security control | Semantic safety detection observed? |
| --- | --- | --- | --- |
| LVIS | `.sh` files only, shell subprocess | hash lockfile, quarantine, strict deny, fail-closed runtime | No general semantic detector; strict structural gate |
| Codex | generic command hook | `/hooks` review/trust, managed hook policy | Not observed in docs |
| Claude Code | command, HTTP, MCP tool, prompt, agent | `/hooks`, managed-only mode, URL/env allowlists, timeout, settings policy | Not observed in docs |
| OpenCode | JS/TS plugin hooks | plugin trust and plugin loading policy | Not observed in docs |
| Kilo Code | JS/TS plugin hooks | plugin trust and plugin loading policy | Not observed in docs |
| Warp | third-party agent integration | delegates hook behavior to integrated agent/runtime | Not applicable from checked docs |
| Hermes Agent | Python gateway/plugin hooks and shell hooks | plugin/config trust, hook type separation | Not observed in docs |

Important conclusion:

Codex and Claude Code rely heavily on explicit user/admin trust and allowlist
controls. They do not appear, from the checked documentation, to run a general
semantic security scanner that proves a hook is safe before execution.

---

## 7. LVIS Gaps And Recommendations

| Gap | Impact | Recommended response |
| --- | --- | --- |
| `.sh` only production hook support | Python/Node/binary hooks require shell wrappers | Add Codex-style `type: "command"` support |
| No matcher groups | Cannot target specific tools/events without custom script logic | Add event + matcher + handler registry |
| No lifecycle hooks beyond tool use | Cannot implement prompt scanning, session context loading, or stop validators | Add `SessionStart`, `UserPromptSubmit`, `Stop`, compact events |
| No HTTP hook policy | HTTP hook support would be unsafe without URL/env controls | Design URL allowlist, env allowlist, method/body/timeout limits before implementation |
| No prompt/agent hook governance | Prompt/agent hooks can modify model behavior | Defer until signed/managed policy and context audit exist |
| No input mutation in external hooks | Safer, but limits compatibility | Keep disabled until hook signing/trust is stronger |

### 7.1 Short term: add generic command hooks, not HTTP/agent hooks first

The lowest-friction compatibility step is to support a Codex-style
`type: "command"` hook model while keeping LVIS's existing quarantine and hash
trust behavior.

Recommended constraints:

- Command path or command string must be visible in the trust UI.
- Hash should cover the referenced script file when the command points at a local file.
- Environment should remain allowlisted, like the current `LVIS_HOOK_*` model.
- Timeout should be explicit and capped.
- Default unknown or changed hook behavior should remain quarantine/deny.

This would allow Python, Node, shell, and binary hooks without immediately
opening HTTP or agent hooks.

### 7.2 Medium term: add lifecycle events

High-value events to add:

- `SessionStart`
- `UserPromptSubmit`
- `Stop`
- `PreCompact`
- `PostCompact`
- `PostToolUseFailure`
- `PermissionDenied`

These align LVIS with Codex/Claude without changing the trust model too much.

### 7.3 HTTP hooks require a stronger policy layer

Before adding HTTP hooks, LVIS should require:

- allowed URL list
- method restrictions
- header/env interpolation allowlist
- timeout and body-size limits
- TLS requirement unless explicitly local loopback
- clear fail-open vs fail-closed behavior per event
- audit entry with URL, event, decision, and duration

### 7.4 Agent/prompt hooks should be last

Agent and prompt hooks are the highest-risk category because they can influence
model context and decisions. LVIS should not enable them until these are in
place:

- signed or managed hook policy
- model-visible context diff/audit
- per-event permission model
- hard caps on turns, tokens, and duration
- source labeling in UI and audit
- opt-in managed-only mode for enterprise deployments

---

## 8. Proposed Direction

Keep the current `.sh` path as the secure baseline, then introduce a new hook
manifest/config layer that supports:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|apply_patch|mcp__.*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.config/lvis/hooks/pre_tool_policy.py",
            "timeoutMs": 5000
          }
        ]
      }
    ]
  }
}
```

Do not remove the existing `pre-*.sh`, `post-*.sh`, `perm-*.sh` convention in
the first migration. Treat it as the v1 compatibility layer and map it into the
new internal hook registry.

The security invariant should remain:

> A hook can downgrade or add context, but it must not silently bypass an
> upstream deny. Any capability that mutates tool input or model context must be
> explicitly trusted, audited, and bounded.
