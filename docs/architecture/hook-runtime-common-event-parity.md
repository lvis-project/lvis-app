# Hook runtime — common-event parity with the agent-connector canonical set

Status: Proposed
Last updated: 2026-07-22
Relates to: #811 (hook runtime compatibility), #1235 / #1236 (HTTP / context-altering hooks)

## Why

`agent-connector` (github.com/ken-jo/agent-connector) normalizes host hook systems
into a small canonical event union that it dispatches across 22 `json-stdio`
hosts + 8 `ts-plugin` hosts (Claude Code, Codex, Cursor, Gemini, OpenCode, Kilo,
Copilot, Warp, Hermes, and more — see its `/coverage`). That normalized union is
the de-facto **common hook set**: the events that are portable across the agent
ecosystem. This doc measures LVIS against it and specifies the gap to close so
LVIS's hook surface is at parity with the common standard.

## The canonical common set (13 normalized events)

From `agent-connector` `/docs/dev/hooks` (`HooksConfig`), every event extends a
base `{ hostPlatform, connectorId, sessionId, projectDir?, raw }`:

| # | Event | Extra payload | Class |
|---|---|---|---|
| 1 | `SessionStart` | `source: "startup" \| "compact" \| "resume" \| "clear"` | observe |
| 2 | `SessionEnd` | `reason?` | observe |
| 3 | `UserPromptSubmit` | `prompt` | blocking |
| 4 | `PreToolUse` | `toolName`, `toolInput` | blocking |
| 5 | `PostToolUse` | `toolName`, `toolInput`, `toolOutput?`, `isError?` | blocking |
| 6 | `PreCompact` | `trigger?: "auto" \| "manual"` | observe |
| 7 | `Stop` | `stopHookActive?` | observe |
| 8 | `Notification` | `message` | observe |
| 9 | `PermissionRequest` | `toolName`, `toolInput`, `permissionSuggestions?` | blocking |
| 10 | `PostToolUseFailure` | `toolName`, `toolInput`, `error`, `isInterrupt?`, `durationMs?` | observe |
| 11 | `SubagentStart` | `agentId?`, `agentType?` | observe (+context) |
| 12 | `SubagentStop` | `agentId?`, `agentType?`, `agentTranscriptPath?`, `lastAssistantMessage?`, `stopHookActive?` | observe |
| 13 | `PostCompact` | `trigger?: "auto" \| "manual"` | observe |

The normalized reply is a `HookResponse`: `decision` (`allow` / `deny` /
`modify` / `context` / `ask`), `reason`, `updatedInput`, `additionalContext`,
`updatedOutput` — with the host formatting whatever fields it can honor.

## Where LVIS stands: 9 of 13 already shipped

LVIS's hook runtime (`src/hooks/`) already covers 9 canonical events. Source of
truth: `src/hooks/hook-config.ts` `EVENT_KEY_TO_TYPE` +
`src/hooks/script-hook-types.ts` `LifecycleHookEvent`.

| Canonical event | LVIS status | LVIS key |
|---|---|---|
| `PreToolUse` | shipped (blocking, `.sh` prefix) | `pre` |
| `PostToolUse` | shipped (blocking, `.sh` prefix) | `post` |
| `PermissionRequest` | shipped (blocking, `.sh` prefix) | `perm` |
| `UserPromptSubmit` | shipped (blocking, fail-closed; #811 m2) | `UserPromptSubmit` |
| `SessionStart` | shipped (observe; #811 m2) | `SessionStart` |
| `Stop` | shipped (observe; #811 m2) | `Stop` |
| `PreCompact` | shipped (observe; #811 m2) | `PreCompact` |
| `PostCompact` | shipped (observe; #811 m2) | `PostCompact` |
| `PostToolUseFailure` | shipped (observe; #811 m2) | `PostToolUseFailure` |
| **`SessionEnd`** | **MISSING** | — |
| **`Notification`** | **MISSING** | — |
| **`SubagentStart`** | **MISSING** | — |
| **`SubagentStop`** | **MISSING** | — |

LVIS also ships a non-canonical `PermissionDenied` observe event (a forensic
split of a denied `PermissionRequest`) — keep it; it is a superset, not a
divergence.

The blocking-vs-observe split matches the canonical classification: LVIS's
lifecycle events are observe-only (non-blocking, fail-soft) except
`UserPromptSubmit`, which is blocking + fail-closed. The four missing events are
all observe-class, so they slot into the existing observe-only lifecycle path
(`ConversationLoop.fireLifecycleEvent` -> `ScriptHookManager.runLifecycleEvent`)
with no new blocking surface.

## The gap: 4 events, and where each wires in

Design rule (matches the codebase and the project's anti-dead-config stance): an
event key is only declared once it is actually fired at a real dispatch point.
Declared-but-never-fired keys are dead config.

### SubagentStart / SubagentStop  (tractable — do first)
- **Dispatch point:** `src/engine/subagent-runner.ts` `runSpawn` — the child
  `ConversationLoop` is built (~`:1942`) and driven via `await child.runTurn(...)`
  inside a `try` / `catch` / `finally` (~`:2281`-`:2354`). `child.loop` is a full
  `ConversationLoop`, so `child.loop.fireLifecycleEvent(...)` is available.
- **Wiring:** fire `SubagentStart` immediately before the spawn `runTurn`
  (`{ agentType: input.profileMode, agentId: <run id> }`); fire `SubagentStop` in
  the `finally` (`{ agentType, agentId, durationMs, stopReason: childStopReason }`).
  Fire on the CHILD loop so the events carry the subagent's `sessionId`, matching
  the canonical semantics where `SubagentStart` context lands in the subagent's
  conversation.
- **Payload:** extend `LifecycleEventPayload` (`src/hooks/script-hook-manager.ts:89`)
  with optional `agentId?: string; agentType?: string;` (the interface is already
  a flat optional bag, so this is additive).
- **Scope note:** observe-only in v1. The canonical `SubagentStart` also supports
  a `context` decision (inject `additionalContext` into the child before its first
  prompt) — that is a follow-up once LVIS's lifecycle path grows a
  context-injection return, and is out of scope for parity-on-the-event.

### SessionEnd  (medium — needs the close point)
- **Dispatch point:** the counterpart to the existing `SessionStart` fire. Locate
  the single authoritative "a session's active lifecycle ended" point (session
  close / switch-away / clear) and fire `SessionEnd` there with
  `{ reason?, sessionMeta }`, mirroring `SessionStart`. Observe-only.
- **Risk:** picking the wrong point double-fires or misses; pin it to one owner
  (the same layer that emits `SessionStart`).

### Notification  (heaviest — cross-process)
- **Dispatch point:** `src/main/notification-service.ts` (`NotificationService`)
  runs in the MAIN process; the hook path runs in the engine
  (`ConversationLoop.fireLifecycleEvent`). Firing `Notification` on a shown
  toast requires a main -> engine signal (IPC/bus) so the engine can dispatch the
  hook with `{ message }`.
- **Decision needed:** whether user-facing notifications are in-scope for hooks at
  all, or only agent-authored notifications. Scope this before building the
  plumbing.

## Phased plan

1. **Phase 1 — SubagentStart / SubagentStop.** Type + config + payload additions
   and the `runSpawn` wiring above, plus a test that spawns a subagent and asserts
   both events fire once with the right `agentType` / `agentId`. Self-contained;
   no new blocking surface; closes the two highest-value gaps (subagent
   observability).
2. **Phase 2 — SessionEnd.** After pinning the single session-close owner.
3. **Phase 3 — Notification.** After deciding scope + the main -> engine signal.

Each phase declares the event key only alongside its fire point. After Phase 3,
LVIS is at 13/13 canonical parity (14 counting `PermissionDenied`), and its hook
surface matches the common set the agent ecosystem shares.

## Non-goals

- No change to the blocking events or the trust/quarantine baseline
  (`src/hooks/hook-trust-*`); the new events are observe-only.
- No `nativeHooks`-style verbatim passthrough for host-only events in this pass
  (that is a separate extensibility feature).
- No context-injection / `modify` capability for lifecycle events yet (tracked
  separately; see `#1236`).
