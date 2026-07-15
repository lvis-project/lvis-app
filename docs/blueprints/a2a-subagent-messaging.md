# A2A Inter-Subagent Messaging — Blueprint

- Status: **Accepted; ph1-ph3 merged; ph4 P4-0 closed and P4-1 registry admission merged** (D1-D8 locked by the owner on 2026-07-11; ph4 boundary locked 2026-07-15)
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

### Ph2 implementation contract

- **Tool surface and addressing**: `agent_send` is globally registered but model-hidden. A fresh depth-1 child receives a model-visible clone in its frozen scoped registry; a resumed child receives it only when that exact scope was persisted at spawn. Main/side-chat/routine loops and legacy child sessions never gain it implicitly. The only addresses are the literal `parent` and a host-minted `childSessionId`; profile names remain display-only. The public payload accepts A2A TextPart, URL FilePart, and DataPart shapes. Raw/base64 FilePart payloads are rejected.
- **Question commit ordering**: `waitForReply:true` is valid only for `to:"parent"` with exactly one TextPart and one outstanding reservation. The bus DLP-canonicalizes the Message and reserves its tree sequence without exposing it to the parent. The child then terminates, persists history plus `INPUT_REQUIRED(reason="question")`, and only afterward commits the single parent Message with host-owned `taskState` and structured `suspension { reason, prompt, resumeId }` metadata. If Message commit fails, the stage is rolled back and a terminal failure is persisted. If that terminal overwrite also fails, the previously persisted `INPUT_REQUIRED` projection remains authoritative as a renderer `waiting` / `agent_status` pull fallback; no retryable stage or parent guidance is exposed. No parked coroutine or internal timer exists. Foreground questions return through the awaited `agent_spawn` result instead of pushing into a parent that has no round boundary.
- **Sibling delivery and ACK**: an active recipient uses mailbox-first `queueGuidance()` steering and acknowledges only after the injected assistant round commits. Queue rejection, provider failure, interruption, round cap, and turn-end races retain or roll back the exact durable entry as appropriate. An idle recipient accepts a durable Message only while authoritatively `INPUT_REQUIRED`; resume revalidates ownership and DLP provenance, then acknowledges only on natural `end_turn` or a new `input-required` stop. A terminal recipient never consumes guidance: terminal metadata commits first, then its late mailbox entries are audited and removed.
- **Causality and bounds**: every accepted edge receives a host-only monotonic tree sequence and causal hop. The limits are 8 hops, 64 accepted Messages per origin tree, and 100 tracked trees. LRU eviction is permitted only for an origin proven inactive by authoritative in-memory plus bounded persisted sub-agent state and with no pending mailbox entry; active or unanswered `INPUT_REQUIRED` trees keep their counters across restart. The model cannot provide or reset hop, sequence, origin, or budget fields.
- **Receiver security context**: every Part and relevant metadata field passes the shared DLP chokepoint. A received Message monotonically degrades tool trust origin to `agent-message`, preserves the DLP-clean `[Sub-Agent: ...]` approval prefix, and forces otherwise-allowed tool calls—including intercepted host meta tools—through the recipient's own `ApprovalGate`. A question answer is likewise DLP-masked and resumes with `agent-message` trust plus the host-owned `[Sub-Agent: parent]` prefix; concurrent sibling input collapses to the conservative multiple-sources label. A missing permission manager still synthesizes a conservative forced ask; a missing gate denies. Cross-origin, unknown-id, terminal-recipient, hop/budget, storage, or validation failures drop closed and emit a redacted parent-session audit edge.

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

### Ph3 loopback listener and route-family opt-ins (locked 2026-07-13)

Ph3 adds a second independently-consented route family to the existing loopback transport; it does not make the local API a prerequisite for A2A and does not open a second socket.

- **Independent boot gates:** the existing `system.localApiServer` / `LVIS_LOCAL_API=1` gate controls only the `/v1` local-API family. The new `features.a2aLoopbackServer` / `LVIS_A2A=1` gate controls only `/a2a` operations and Agent Card routes. Both remain default OFF. Their values are captured once during boot as an immutable snapshot; changing either setting or environment value takes effect only after restart.
- **One listener, OR startup:** open exactly one `127.0.0.1` listener when at least one route-family gate is enabled (`localEnabled || a2aEnabled`). The listener path-multiplexes all enabled profile handlers; enabling both families never creates a second listener, port, or bearer authority.
- **Route-family gate before parsing:** dispatch by enabled route family before authentication, request-body parsing, or handler lookup. A request for a disabled family—including its Agent Card route—returns `404` without consuming credentials or a body. Thus an A2A-only boot exposes no `/v1` capability, and a local-API-only boot exposes no `/a2a` or Agent Card capability.
- **Failure isolation:** A2A profile/card initialization failure disables the A2A family for that boot and is audited, but must not prevent an enabled `/v1` family from starting or continuing. If A2A was the only enabled family and initialization leaves no routable handler, no empty listener is retained. Listener-bind failure remains a boot-local external-surface failure and must not brick the desktop application.

These rules refine only the ph3 wire attachment. They do not alter D1–D8: the in-process semantic bus remains authoritative, A2A runtime SDK adoption remains prohibited, and the depth-1 creation hard-stop remains unchanged.

### Ph3 wire mutation consent (locked 2026-07-14)

The loopback bearer authenticates the local caller; it does not authorize an A2A mutation. Every non-replayed `SendMessage` and every live `CancelTask` request must additionally pass an in-app `agent-action` consent gate before the first runner or durable-store mutation.

- **Ordering:** parse and validate the request, DLP-canonicalize every inbound Part, resolve exact durable duplicates, and validate ownership/state/context/history before consent. A new initial send also acquires one bounded, non-durable in-memory admission reservation so capacity and competing mutations fail before the prompt; this is not a runner or durable-store mutation. After consent, the handler revalidates and commits under the Task lock. Invalid, cross-handler, conflicting-duplicate, terminal, or over-capacity requests never open a consent prompt.
- **Denied admission:** a missing gate, explicit denial, timeout, thrown gate, or concurrent distinct mutation fails closed with the host-only JSON-RPC server error `{ code: -32010, message: "Operation rejected", reason: "OPERATION_REJECTED" }`. Its `ErrorInfo` metadata uses the host domain `lvis-project.github.io`; the extension remains outside the vendored A2A v1.0 error registry. A denied initial send creates no Task; a denied continuation or cancel leaves the existing Task state and history byte-equivalent. Waiting for this pre-task decision starts no child and consumes zero child rounds. It is never projected as `AUTH_REQUIRED` or Task `REJECTED`.
- **Prompt bounds:** identical initial sends coalesce through the handler's in-flight key, while identical continuation or cancel mutations coalesce through a pre-lock Task reservation. A distinct concurrent mutation is denied immediately without opening or queueing a second modal. Every admitted mutation is revalidated and committed under the Task lock. The production handler factory must share one single-flight consent coordinator across every exposed profile handler, so at most one external-mutation modal is pending for the host. `allow-always` remains a one-shot decision because no remembered grant is persisted.
- **Read and replay behavior:** Agent Card, `GetTask`, `ListTasks`, an exact durable Message replay, and an already-CANCELED `CancelTask` replay do not request mutation consent. A task-less initial replay matches only the Task's first history Message; a continuation replay must retain its Task binding. Internal reconciliation may monotonically project an authoritative runner snapshot but grants no new caller capability.
- **Two independent gates:** wire admission consent authorizes only this host mutation. Any tool call caused by the received Message still carries `agent-message` trust and the `[A2A Wire]` provenance label through the receiver's own `ApprovalGate`; the admission decision cannot bypass or pre-authorize that second gate.
- **Audit privacy:** denial and ownership failures emit redacted host-owned identifiers only. Raw Parts, request arguments, ApprovalGate errors, and provider details never cross the diagnostic seam.

### Ph3 production attachment contract (2026-07-14)

The production attachment resolves the previously test-only router factory without adding another process, listener, or SDK runtime.

- **Immutable handler snapshot:** the A2A gate lazily snapshots the current `AgentProfileStore` list, active `SubAgentRunner`, and conversation project binding once for the boot. At most 32 routable profiles are admitted. Missing runner/profile services, an invalid host binding, or an ID collision disables the whole A2A family for that boot; an empty profile list retains no A2A-only listener.
- **Opaque addresses:** each handler URL uses `agent-<letter-encoded sha256(canonical-real-profile-path)[:32]>`. The letters-only structural alphabet prevents a random digest from being misclassified as phone/card PII by the mandatory DLP validator. Profile `name` remains display-only and never becomes a path segment. Name, body, tool, model, or mode edits keep the same address; moving the profile file changes it. Stable identity across moves would require a separately persisted host-minted profile UUID, which the current profile schema does not contain.
- **Minimal Agent Cards:** the public card contains only a DLP-clean profile name, a bounded DLP-clean description (otherwise a fixed fallback), application version, one generic delegation skill, `text/plain` modes, explicit false unsupported capabilities, and the bearer scheme. It never includes the profile body/path/tools/triggers/model/mode, project metadata, provider state, approval state, prompts, or the bearer secret.
- **Shared persistence with fair bounds:** every handler uses one `openFeatureNamespace("a2a-loopback")` Task store so cross-handler ownership remains detectable. The immutable active-handler set drops and audits removed-profile records in memory. Bounds are 100 Tasks per handler, 32 handlers/3,200 Tasks globally, and 64 history Messages per Task; a handler may evict only its own oldest terminal Tasks.
- **One host consent coordinator:** the existing listener creates one boot-scoped single-flight `AgentActionApprover` and passes the same instance to `/v1` external mutations and every A2A handler. A startup retry may rebuild a disposed A2A runtime but never forks the consent coordinator within that boot.
- **Local discovery and lifecycle:** the existing mode-`0o600` `~/.lvis/local-api/server.json` gains an optional `a2a` object containing protocol version and sorted relative Agent Card paths only when A2A is actually active. Shutdown, late factory completion, bind/discovery failure, and retry dispose each produced runtime exactly once; a cached `null` initialization remains disabled for the rest of the boot.

### Ph3 wire Task expiry (locked 2026-07-15)

The wire age-out policy is fixed and does not change D6's rule against an internal unanswered-question timer. It applies only to durable A2A Tasks exposed by the ph3 binding.

- **Deadline and eligibility:** every `INPUT_REQUIRED` Task expires exactly seven days after its persisted `TaskStatus.timestamp`, for both `suspension.reason="budget"` and `suspension.reason="question"`. Only a new authoritative transition into an `INPUT_REQUIRED` episode resets that timestamp. Reads, replay, same-state reconciliation, process restart, and timer rescheduling do not refresh it. `SUBMITTED`, `WORKING`, and every terminal state are exempt; active provider work is therefore never canceled by this age-out.
- **Bounded scheduler:** each production handler owns at most one timer for its nearest eligible deadline. Boot enumerates that handler's bounded nonterminal records and reconciles each against the runner before considering expiry, so a persisted terminal runner result wins over stale wire state. Shutdown/disposal clears the timer and drains its in-flight sweep.
- **Race-safe expiry:** at a deadline, the handler acquires the existing per-Task lock, refetches the record, reconciles the runner first, refetches again, and rechecks state, timestamp, ownership, and deadline. It cancels the runner before persisting `CANCELED`. The terminal transition is message-less so a full 64-Message history cannot strand a successfully canceled run in `INPUT_REQUIRED`.
- **Failure behavior:** a runner-cancel or storage failure preserves the current Task state, is audited without Message content, and retries after 60 seconds. There is no hot loop and no Task-schema TTL field; the persisted status timestamp remains the sole deadline source.

The official TCK and the production-handler smoke serve different evidence boundaries. `scripts/run-a2a-tck.ts` pins upstream commit `5996b79f9cefa6fc390980e383e358a66fb9e49e` and runs the official suite through the production JSON-RPC router and bearer boundary, but deliberately supplies the deterministic `A2ATckFixtureHandler`. That proves the router/binding contract and report expectations; it does not exercise `A2ASubAgentHandler`, the durable Task store, or the runner. The opt-in `bun run test:a2a-external` gate therefore uses the locked official Python SDK to address the real production Agent Card and handler and cover COMPLETED, INPUT_REQUIRED continuation, CANCELED, and rejected authentication.

### Ph4 decomposition and P4-1 registry admission (locked 2026-07-15)

P4-0 closes the documentation/evidence lag after the ph3 runtime, expiry,
official-TCK, and production-handler smoke changes merged. Ph4 starts from the
following boundary; it does not reopen ph3's loopback listener contract.

- **P4-1 owner and purpose:** the active public `agent-hub` Node/TypeScript
  server owns a pure Agent Card registry admission module. It accepts one
  already-retrieved card, validates the
  bounded LVIS/A2A v1 subset, and returns an immutable admission result.
- **Transport/auth floor:** every admitted interface is HTTPS, uses the A2A
  `JSONRPC` binding and a supported protocol version, and declares at least one
  internally consistent bearer security requirement. Missing or contradictory
  authentication metadata fails closed even though those fields are optional
  in the generic protocol.
- **Trust states:** a structurally valid unsigned card or a card signed only by
  unknown keys is `discovered`. A detached JWS `ES256` or `EdDSA` signature
  verified by an explicitly supplied active Agent Card trust key promotes it
  to `trusted`. A malformed signature, a revoked known key, or a failed
  signature from a known key is rejected. P4-1 does not read the Agent Hub
  identity database or implicitly treat signup keys as Agent Card trust anchors.
- **No hidden I/O:** P4-1 performs no discovery fetch, `jku`/JWKS retrieval,
  credential lookup, database write, cache update, or endpoint probe. A `jku`,
  when present, is syntax-checked as HTTPS only; key retrieval belongs to a
  later explicitly bounded stage.
- **No execution effect:** both `discovered` and `trusted` results return
  `routable=false`. P4-1 does not register a tool, select a remote agent, invoke
  `SubAgentRunner`, or alter local mailbox/question/resume behavior.
- **D8 remains locked:** ph4 registration expands the set of identities that
  may become eligible for a future remote route; it does not relax the
  depth-1 creation hard-stop. Any delegation-depth change requires a separate
  policy decision and regression/security review after routing exists.
- **Merge evidence (2026-07-15):** the P4-0 contract landed in
  [`lvis-app#1636`](https://github.com/lvis-project/lvis-app/pull/1636) as merge
  commit
  [`6a7a777873e04e968d3338bb723fba404e26c928`](https://github.com/lvis-project/lvis-app/commit/6a7a777873e04e968d3338bb723fba404e26c928),
  and the P4-1 admission core landed in
  [`agent-hub#15`](https://github.com/lvis-project/agent-hub/pull/15) as merge
  commit
  [`8856b193b8417e9e4b61421be47904030ab25b2e`](https://github.com/lvis-project/agent-hub/commit/8856b193b8417e9e4b61421be47904030ab25b2e).
  The merged implementation remains pure admission with no hidden I/O or
  execution effect: every result is `routable=false`, local
  mailbox/question/resume behavior is unchanged, and D8 remains depth-1.
- **P4-1 hardening evidence (2026-07-15):** the DEL/C1 control-character
  follow-up landed through
  [`agent-hub#17`](https://github.com/lvis-project/agent-hub/pull/17). GitHub
  records its PR `merged_at` as `2026-07-15T07:06:51Z` and its
  `merge_commit_sha` as
  [`f8b50e734d92b1ad4590e730820c9c4207331cab`](https://github.com/lvis-project/agent-hub/commit/f8b50e734d92b1ad4590e730820c9c4207331cab);
  that commit's committer timestamp is `2026-07-15T07:06:50Z`. The related
  [`agent-hub#16`](https://github.com/lvis-project/agent-hub/issues/16) issue
  was closed with state reason `completed` at `2026-07-15T07:06:52Z`. This
  closes only the P4-1
  input-validation follow-up. It adds no persistence, trust-review workflow,
  discovery/JWKS I/O, credential provisioning, endpoint probe, plugin
  registration, or remote routing; admission remains offline and every result
  remains `routable=false`.

Persistence, administrative trust review, key lifecycle distribution,
credential provisioning, endpoint health, plugin work-assistant registration,
and remote routing are deliberately deferred beyond P4-1. No later stage may
infer routability from `trusted` alone.

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
