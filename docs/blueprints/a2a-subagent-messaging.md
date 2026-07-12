# A2A Inter-Subagent Messaging — Blueprint

- Status: **Accepted; ph1 commissioned** (D1-D8 locked by the owner on 2026-07-11)
- Scope: upgrade LVIS sub-agents from "tool-call-level" (pull-only child→parent) to A2A-protocol-based messaging — child→parent push, sibling↔sibling messaging — while preserving every existing security invariant.
- Protocol baseline: **A2A v1.0.0** (Linux Foundation, a2a-protocol.org). Complementary to MCP (MCP = agent↔tool, A2A = agent↔agent); coexists with the ext-apps adoption track.
- Roadmap anchor: concretizes the Agent Hub vision item "A2A Runtime — 에이전트 간 비동기 위임·합의·결과 전달" (docs/ko/architecture/architecture.md Phase 5-6, previously ❌ 미구현).

## Decision record (locked 2026-07-11)

| # | Decision | Choice |
|---|---|---|
| D1 | Transport lane | **In-process A2A-semantic bus first**; loopback wire binding deferred to ph3 (opt-in, default OFF) |
| D2 | SDK lane | **Types-only**: vendor A2A v1.0 schemas + state machine; do NOT adopt `@a2a-js/sdk` runtime in ph1-2 (re-evaluate its Express glue at ph3 when a wire exists) |
| D3 | Idle-parent wake | **Both**: manual default (mailbox joins the user's next turn) + opt-in autonomous wake (queued child Message may start a parent turn, routed through the `UserPromptSubmit` gate) |
| D4 | Suspension state model | **(b) single `INPUT_REQUIRED` + typed `reason: "budget" \| "question"`**, with mechanic **(i) terminate-round-with-resume-handle** |
| D5 | AUTH_REQUIRED | **Not projected.** Host approval-gate / plugin-auth waits stay WORKING(+status) — they are human gates a remote client cannot satisfy (fail-honest) |
| D6 | Unanswered question TTL | **No internal timer** (age-out via MAX_TRACKED_RUNS only); at the ph3 wire attach an A2A task TTL emitting CANCELED on expiry so external clients get a terminal state |
| D7 | Sibling addressing SoT | `childSessionId` (host-minted `sub-<sha256(origin)[:8]>-<uuid>`, unforgeable); profile `name` is display-only |
| D8 | Delegation depth | Unchanged: spawnDepth hard-stop (depth-1). Messaging expands the **communication** graph, never the **creation** graph. True delegation chains are a ph4 question |

## Why in-process first (D1/D2)

Sub-agents are in-process child `ConversationLoop`s (`src/engine/subagent-runner.ts`); a second in-process loop is an established pattern (side-chat, `src/ipc/domains/sidechat.ts`). No official A2A SDK ships an in-memory transport and none documents multi-agent hosting — a loopback HTTP mesh would tax every intra-process hop (JSON-RPC + TCP + SSE) for an external consumer that does not exist until ph3/ph4. The bus preserves A2A v1.0 **data shapes** (Task/Message/Part/Artifact) and **state machine** so the ph3 wire binding is a projection, not a redesign.

**Accepted risk (stated honestly):** ph1-2 cannot run the official a2a-tck conformance kit (no wire). Mitigation: vendor v1.0 types as the compile-time contract AND port the TCK's state-transition assertions as in-process unit tests. This narrows but does not close the drift risk; ph3 runs the real TCK.

## Engine reality the design is built on (verified)

- **There are no parked loops.** Every stop today is terminate-and-return; the only in-flight block is the approval gate (bounded 300s, auto-deny — `tool-timeout-policy.ts` `approvalGateUserWaitMs`). Budget suspension is a finished `runTurn` flagged `incomplete` + a `resumeId` that re-hydrates history on demand.
- `resume(continuationInstructions)` already functions as "reply to a suspended agent" (`subagent-runner.ts:1033`) with frozen tool scope.
- The race-safe injection seam for pushing into a **running** parent exists: `ConversationLoop.queueGuidance()` (`conversation-loop.ts:245`), drained at round boundaries (`query-loop.ts:269-327`, bounded by GUIDE_MAX_*). Those bounds have no time-based TTL; D6 remains the only TTL policy.

## State model (D4/D5) — transition table

| LVIS internal | A2A projection | Renderer label | Resumable |
|---|---|---|---|
| running turn | WORKING | `running` | in flight |
| natural `end_turn` | COMPLETED | `done` | no |
| round-cap (`suspension.reason="budget"`) | **INPUT_REQUIRED** (reason=budget) | **`waiting`** (new) | yes — `resume(resumeId, "continue" or new guidance)` |
| question-wait (`suspension.reason="question"`) [ph2] | **INPUT_REQUIRED** (reason=question) | **`waiting`** (new) | yes — `resume(resumeId, answer)` |
| approval-gate / plugin-auth wait | WORKING (+status) | `running` | in flight (auto-deny/timeout) |
| child threw / provider missing | FAILED | `error` | no |
| `agent_interrupt` | CANCELED | `interrupted` | no |
| resume-exhausted / cross-origin refusal | REJECTED or FAILED | `error` | no |

Notes:
- Under mechanic (i), budget-suspension and question-wait are the SAME machinery (terminate + resume); the `reason` field is what tells a consumer whether it must *answer* or may merely *nudge*. Spec tension acknowledged: strict INPUT_REQUIRED means "cannot proceed without input," while a budget suspension can proceed on a bare "continue" — INPUT_REQUIRED is used as the closest slot for the PAUSED-resumable state A2A's vocabulary lacks. Every status Message MUST carry machine-readable `reason` plus prompt text written for the case ("answer: <q>" vs "send any message to continue, or treat as done").
- Discipline guard: because (b)'s safety rests on consumers reading `reason`, the suspension type is structural — `suspension?: { reason: "budget" | "question"; prompt?: string; resumeId: string }` replaces the bare `incomplete: true` (kept temporarily as a derived alias). Tests assert both reasons round-trip.
- Waiting consumes **zero rounds** structurally (nothing is running). `CUMULATIVE_ROUNDS_CEILING` (4×30) is a hard total-work bound: a near-ceiling resume is clamped to the remaining rounds, and assistant rounds completed before a later failure still count. `MAX_RESUMES=3` counts budget continuations only; `questionAnswerCount` is a separate axis even though ph1 does not yet emit `reason:"question"`.

## Messaging model

- **child→parent push (ph1)**: `deliverToParent(message)` → running parent: `queueGuidance(formatAgentMessage(...))`, drained at the next round boundary. Delivery is **mailbox-first** and acknowledged only after the next assistant round successfully commits after consuming the guidance; preflight/provider failure rolls back the exact injected history row and leaves the durable entry for retry. Queue rejection or a turn-end race likewise leaves the entry durable. With autonomous wake enabled, queue overflow requests the existing lease-aware wake handler immediately and a turn-end drop schedules its bounded recheck; with the default setting both remain for the user's next turn. **Background spawns only** — ph1 automatically projects every linked background `agent_spawn` terminal result (including setup rejection) into exactly one A2A Message and one terminal renderer event. The production main conversation loop is the only ph1 surface with the host-owned `supportsA2AParentDelivery` capability; side-chat, routine, and other loops omit it and fail closed with `background-parent-unsupported` before runner lookup or event emission. Tool input cannot enable this capability. A foreground parent is parked inside the tool executor awaiting the child promise and reaches no round boundary until the child returns, so foreground spawns keep the existing tool-result path and do not push. Idle parent: durable mailbox under the `subagent-messaging` feature namespace; joins the user's next turn (manual default), or — opt-in — starts a fresh parent turn through the `UserPromptSubmit` gate (D3). The wake handler waits for at most the current stream/session-mutation lease, then revalidates the exact main session and idle state before starting a turn; there are no timers, polling loops, or session switches. `agent_status` polling remains the pull fallback. No new child messaging tool is added in ph1 (`agent_send` remains ph2).
- **Mailbox trust boundary (ph1)**: persisted entries are untrusted at every peek and wake recheck. The bus re-resolves the host-owned child address and requires exact parent/child ownership plus a canonical DLP-clean Message/title/rendered text/ApprovalGate label. Duplicate storage IDs are all quarantined; duplicate semantic `(parent, child, context, messageId)` deliveries are idempotently rejected. Normalization reports cross-origin, invalid, and budget drops through the same redacted audit SOT before durable cleanup. A failed cleanup or authoritative quarantine exposes zero guidance, retains the original durable state, and retries without duplicating audit events. Idle-parent snapshots are acknowledged only after a natural `end_turn`; failed, interrupted, truncated, or round-capped turns remove the temporary history copy and retain the mailbox entry so the next turn restores the same provenance gate.
- **Terminal-state consistency (ph1)**: interruption is sticky from `SUBMITTED` onward and terminal A2A states never regress to `WORKING`. Metadata/setup failures terminalize the tracked run, renderer event, tool result, and parent Message to the same `FAILED` or cancellation-preferred `CANCELED` state, with no stale running handle.
- **sibling↔sibling (ph2)**: parent-mediated routing via a new depth-aware `agent_send` tool — no direct peer channel. Runner validates sender and recipient share `originSessionId`; delivery lands in the recipient's mailbox/queueGuidance; every A→B edge is audited under the parent session. Addressing per D7.
- **question-wait (ph2)**: a child asks the parent by terminating its round with `suspension.reason="question"`; the parent's answer arrives as `resume(resumeId, answer)`. No parked coroutine is introduced anywhere (D4 mechanic i).
- **Backpressure**: ph1 reuses per-message GUIDE_MAX_CHARS plus per-mailbox GUIDE_MAX_ENTRIES and joined-chars bounds; overflow is a fail-closed audited drop. There is no internal timer. The per-delegation-tree message budget and hop-count envelope guard arrive with sibling routing in ph2, where A→B→A cycles first become possible. Each received message that triggers an LLM round draws from the receiver's own round budgets.

## Security model

Central invariant: **messaging expands the communication graph, never the creation graph** (D8). Every cross-agent Message passes:
1. **DLP masking** on all Parts (same chokepoints as transcript snapshots);
2. the **receiver's own ApprovalGate** for any tool use the message provokes (`[Sub-Agent: <title>]` provenance is carried into every permission reason, including otherwise auto-allowed tools) — a message bypasses nothing;
3. ph1's fixed one-hop child→parent route plus GUIDE/mailbox bounds; **per-tree budget + hop-count guard** extends this invariant when sibling routing lands in ph2;
4. **fail-closed**: cross-origin, unknown id, or budget-exhausted → drop + audit event.

Identity in-process = host-minted origin-tagged `childSessionId` (unforgeable; no bearer tokens until the ph3 wire, which then inherits the local-api consent model: Bearer authenticates the caller, the user's in-app Allow authorizes mutations).

## Known live bug folded into ph1

The workspace rail renders a budget-suspended run as `done`: the done event hardcodes `status: stopReason==="interrupted" ? "interrupted" : "done"` (`src/tools/agent-spawn.ts:314`) and the reducer drops `incomplete` (`use-workflow-tools.ts:108`), while the tracked-run snapshot does carry `stopReason`. ph1 adds the `waiting` renderer state driven by `suspension` and widens the done-event payload in the same PR (field-addition sweep rule).

## Phases

| Phase | Scope | Effort | Gate |
|---|---|---|---|
| **ph1** | Vendor v1.0 types; Task-state mapping; `suspension` type evolution (+ MAX_RESUMES decoupling prep); child→parent push (queueGuidance + mailbox + D3 wake); renderer `waiting` state (live-bug fix); TCK state-transition unit tests | M (~2-3wk) | host minor release |
| **ph2** | agent_send sibling messaging (parent-mediated); active-recipient round-boundary steering + idle mailbox reuse; per-tree budget + hop TTL; DLP chokepoint on Parts; audit edges; question-wait (reason: question) | M | next host minor |
| **ph3** | Loopback wire binding: one 127.0.0.1 server path-multiplexing N handlers; Agent Card endpoint; protocol-version negotiation; SSE capability gating; A2A task TTL→CANCELED (D6); **official a2a-tck conformance**; re-evaluate the JavaScript SDK server glue; local external-host smoke against one A2A client | L | opt-in flag, default OFF |
| **ph4** | External interop / Agent Hub: cross-machine, per-agent auth, Agent Card registry; plugin work-assistant registration; delegation-depth policy revisit (D8) | XL | separate opt-in |

## Cross-host implementation review and follow-on constraints

A fourth review lane compared current CLI/Desktop hosts using primary sources. The detailed notes and contribution drafts live in [the upstream contribution candidates](../research/a2a-upstream-contribution-candidates.md).

- **Codex CLI/app-server** exposes host-native parent/child thread IDs, structured collaboration items, active-turn steering, and explicit history injection. This reinforces the split between a live steer and a durable idle delivery; it does not replace the ph1 mailbox commit/ACK transaction.
- **Gemini CLI** isolates each local subagent's tools and confirmation label, forbids recursive agent tools, queues background completions at an inter-turn boundary, and can consume remote A2A agents through Agent Cards. It is the preferred ph3 loopback interoperability smoke target, but the test must negotiate the supported protocol version rather than assume its documentation examples are v1.
- **goose CLI/Desktop** runs subagents as separate Agent/session instances with cancellation and structured tool notifications through a shared engine. This supports one lifecycle pipeline for foreground, background, CLI, and Desktop projections.
- **OpenHands CLI/GUI** demonstrates a typed event stream for agent/runtime/UI interaction. Its internal delegation events are useful UI precedent, not evidence of A2A conformance.

Resulting constraints:

1. Ph2 sends to an active recipient only at its safe inter-round boundary; interrupt/restart is a separate explicit operation.
2. Ph3 keeps the wire opt-in and loopback-only, runs the official TCK, and adds one local external-client smoke covering COMPLETED, INPUT_REQUIRED continuation, CANCELED, and rejected authentication.
3. Ph4 owns cross-machine trust, Agent Card registry policy, and plugin/remote work-assistant registration. None of those relaxes D8's depth-1 creation stop.
## References

Design inputs: A2A v1.0 spec + official SDK survey (2026-07-10 research, npm-registry-verified); transport/SDK-lane design review; INPUT_REQUIRED state-policy review (state inventory table with file:line evidence for `subagent-runner.ts`, `agent-spawn.ts`, `query-loop.ts`, `approval-gate.ts`, `tool-timeout-policy.ts`, `conversation-loop.ts`, `use-workflow-tools.ts`). All internal claims were verified against `main` at authoring time.
