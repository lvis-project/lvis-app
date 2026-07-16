# A2A Inter-Subagent Messaging — Blueprint

- Status: **Accepted; ph1-ph3 merged; ph4 P4-0 closed, P4-1 registry admission merged, P4-2 durable Agent Card registry contract locked, and P4-3/G003 trust-connectivity security contract locked** (D1-D8 locked by the owner on 2026-07-11; ph4 boundary locked 2026-07-15; P4-3 locked 2026-07-16)
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
| **ph4** | External interop / Agent Hub: durable administrator-reviewed Agent Card registry; explicit trust-key, credential, discovery, and health stages; later host↔Agent Hub remote routing. Plugin integration is outside this roadmap. D8 remains unchanged unless a separate policy decision is accepted after routing exists. | XL | separate opt-in |

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

### Ph4 decomposition: P4-1 admission and P4-2 durable registry (locked 2026-07-15)

P4-0 closes the documentation/evidence lag after the ph3 runtime, expiry,
official-TCK, and production-handler smoke changes merged. Ph4 starts from the
following boundary; it does not reopen ph3's loopback listener contract.

- **P4-1 owner and purpose:** the active public `agent-hub` Node/TypeScript
  server owns a pure Agent Card registry admission module. It accepts one
  already-retrieved card, validates the
  bounded LVIS/A2A v1 subset, and returns an immutable admission result.
- **Transport/auth floor:** every admitted interface is HTTPS, uses the A2A
  `JSON-RPC` binding and a supported protocol version, and declares at least one
  internally consistent bearer security requirement. Missing or contradictory
  authentication metadata fails closed even though those fields are optional
  in the generic protocol.
- **Trust states:** a structurally valid unsigned card or a card signed only by
  unknown keys is `discovered`. A detached JWS `ES256` or `EdDSA` signature
  verified by an explicitly supplied active Agent Card trust key promotes it
  to `trusted`. A malformed signature, a revoked known key, or a failed
  signature from a known key fails admission before any result is produced;
  “rejected” is a fail-closed outcome, not an `admissionTrustState`. P4-1 does
  not read the Agent Hub identity database or implicitly treat signup keys as
  Agent Card trust anchors.
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
credential provisioning, endpoint health, and remote routing are deliberately
deferred beyond P4-1. No later stage may infer routability from `trusted`
alone. Plugin work-assistant registration is not part of this roadmap.

#### P4-2 durable Agent Card registry contract

P4-2 is owned by Agent Hub. It persists the evidence produced by the pure P4-1
admission core and adds an administrator-reviewed lifecycle without adding a
network or execution effect. The registry is a trust decision record, not a
router: every returned card/interface projection remains `routable=false`.

##### State and identity model

P4-2 stores two independent state axes and never collapses one into the other:

- Every successful card import, and every successful trust re-verification,
  appends one immutable admission observation.
  `admissionTrustState` belongs to that observation, not to the mutable registry
  record, and is `discovered` or `trusted`. The observation snapshots the exact
  P4-1 result, signature-verification evidence, supplied active trust-anchor
  revisions, authenticated actor, `submission_id`, provenance, and timestamp.
  Later imports or re-verification append observations; they never rewrite an
  earlier `admissionTrustState` or verification snapshot. This evidence is not
  an administrator decision and cannot make the card routable.
- `registryState` is the administrator-owned lifecycle state:
  `discovered`, `trusted`, `rejected`, or `revoked`. The first successful import
  of a new canonical document with a P4-1 `discovered` or `trusted` result
  creates one `registryState=discovered` record. A later submission of that same
  canonical document appends an observation only and does not change its current
  registry state, including `trusted`, `rejected`, or `revoked`.
  A malformed, oversized, or signature-invalid admission, or a signature naming
  a known revoked `key_id`, produces no P4-1 result; the HTTP import returns a
  bounded 4xx response and persists no card, observation, audit, or idempotency
  row.
- The P4-1 policy input is the lifecycle-aware set of every known Agent Card
  trust anchor, both `active` and `revoked`, with an explicit active flag. A
  revoked `key_id` remains in the durable admission denylist and fails closed;
  it can never be omitted or downgraded to an unknown key. An Agent Card
  signature carries no public-key fingerprint, so P4-2 does not infer or match
  `key_fingerprint_sha256` for a new unknown `key_id`. Until G003 performs its
  separately bounded key discovery, such an unknown signature may therefore
  remain `admissionTrustState=discovered`. The revoked fingerprint is instead a
  lifetime re-registration/revival denylist at the trust-anchor creation
  boundary. A successful immutable observation snapshots only the active trust
  candidates used for verification, not the revoked admission-denylist rows.
- The only legal persisted transitions are
  `import -> discovered`, `discovered -> trusted | rejected`, and
  `trusted -> revoked`. `rejected` and `revoked` are terminal. Re-importing a
  changed card creates a new discovered record; it never mutates or revives a
  terminal record. Re-importing the same canonical document with a new
  submission records another immutable observation without changing its
  `registryState`.
- No observation, re-import, re-verification, trust-anchor addition, read, or
  startup reconciliation may change `registryState`. Only an explicit
  administrator trust/reject/revoke mutation, or the atomic cascade caused by
  an explicit administrator trust-anchor revocation, may apply a legal state
  transition.
- One host-minted `recordId` identifies one immutable canonical document. A
  changed canonical document receives a new record. Display name, signup
  account, key ID, and mutable request metadata are not registry identities.

##### Hashes, provenance, and trust anchors

- `payloadSha256` preserves the P4-1 signing meaning: it is SHA-256 over the
  canonical signature payload after signatures and protocol defaults are
  stripped. It is not a raw-request-body hash and byte-different JSON encodings
  of the same signing payload therefore produce the same value.
- `canonicalDocumentHash` is SHA-256 over the complete validated Agent Card
  encoded with RFC 8785 JSON Canonicalization Scheme (JCS), including the
  signatures array. It is the complete-document identity used to resolve the
  one immutable registry record. It is distinct from `payloadSha256`; a
  signature-verification observation persists the algorithm, signature key ID,
  outcome, selected anchor internal `id`/`row_version`/`key_id`/fingerprint, and
  the sorted redacted active-anchor revision snapshot separately. That snapshot
  contains only the active trust candidates supplied for signature verification,
  as
  `{ id, row_version, key_id, algorithm, key_fingerprint_sha256 }`. It never
  copies revoked denylist rows, PEM material, raw signatures, or protected
  headers. Here and in every anchor response, `id` is the host-minted numeric
  internal anchor identifier; `key_id` is the administrator-supplied lifetime
  signature-key identifier.
- The registry persists the immutable canonical document, both hashes, import
  source/provenance, importer identity, immutable per-submission admission and
  verification observations, timestamps, administrator decision metadata, and
  an append-only audit history. System-generated audit metadata never copies
  credentials, raw bearer values, private keys, card documents, PEM material,
  raw signatures, or protected headers. A bounded administrator decision reason
  is the only free-text audit field; P4-2 does not claim to detect or redact an
  arbitrary secret that an administrator types into that reason.
- Agent Card trust anchors are explicit locally administered PEM public keys.
  `key_fingerprint_sha256` is lowercase hexadecimal SHA-256 over the DER SPKI
  bytes exported from the parsed canonical public key. This canonical
  fingerprint identifies one trust-anchor aggregate for its entire lifetime.
  That aggregate has one host-minted numeric internal `id`, one
  administrator-supplied `key_id` used for signature-key lookup, algorithm,
  fingerprint, `active -> revoked` terminal lifecycle, creation/revocation
  metadata, monotonically increasing `row_version`, and append-only audit
  history. Create/read responses expose both fields with those meanings;
  mutations target the internal `id`, never `key_id` as an alias. Both
  `key_fingerprint_sha256` and the administrator-supplied `key_id` are
  lifetime-unique. Registering a duplicate active fingerprint or reused
  `key_id` returns 409 with no new anchor, audit, or idempotency row. Once
  revoked, the fingerprint cannot be restored or registered again under a new
  `key_id`; the revoked `key_id` also cannot be reused. Agent Hub signup/login
  identity keys, sessions, and credentials are a separate domain and are never
  implicitly imported, queried, or accepted as Agent Card trust anchors.
- P4-2 does not generate, rotate, fetch, or distribute keys. An administrator
  supplies the PEM material through the explicit registry boundary. Private
  keys are rejected and never persisted.
- A rejected card body, PEM value, or private-key value is never echoed or
  copied into a bounded 4xx response, application log, audit row, observation,
  or idempotency row. The boundary returns only a generic bounded error code and
  message; diagnostics may contain host-generated request identifiers and size
  or category metadata, never rejected raw bytes.

##### Administration, concurrency, and canonical interface

Public HTTP JSON preserves Agent Hub's existing `snake_case` wire convention,
including `expected_version` and `submission_id`. TypeScript internals may use
camelCase, but serializers must keep the wire names explicit and must not add
silent aliases.

- Every P4-2 card, observation, audit, and trust-anchor read or write operation
  is administrator-only. Authentication and administrator authorization run
  before lookup or mutation so an unauthorized caller cannot enumerate record,
  interface, observation, audit, or anchor existence. Caller claims supplied in
  a request body are never authoritative.
- `discovered -> trusted` requires successful re-verification of the exact
  stored canonical document against an active, explicit local Agent Card trust
  anchor, the administrator decision, and the record's current expected
  version. The successful re-verification is appended as a new immutable
  observation in the same transaction as the administrator decision; no prior
  observation is rewritten. An unsigned `admissionTrustState=discovered`
  observation cannot be trusted by administrator override alone.
- Each mutable aggregate carries a monotonically increasing version. A mutation
  of an existing record or trust anchor requires compare-and-swap against its
  own `expected_version`; the state/anchor change, any new observation, the
  audit record, and the successful idempotency result commit in one database
  transaction. A stale version, competing distinct mutation, illegal
  transition, or partial persistence failure fails closed with no mutation.
- Every import, trust, reject, revoke, and trust-anchor mutation is idempotent by
  authenticated administrator actor plus `submission_id`. The stored canonical
  semantic request fingerprint is SHA-256 over JCS-canonicalized,
  operation-tagged validated request semantics:
  - import hashes `{ operation, canonical_document, provenance }`; the complete
    canonical document already contains its preferred interface;
  - trust-anchor creation hashes `{ operation, key_id, algorithm,
    canonical_public_key_pem, key_fingerprint_sha256 }`; and
  - card review/trust/reject/revoke and trust-anchor revoke hash `{ operation,
    target, expected_version, decision, reason, ...validated_request_inputs }`
    for the fields accepted by that specific operation.
  For trust-anchor revoke, `target` is the host-minted internal numeric `id`;
  the administrator-supplied `key_id` is not accepted as a target alias.
  Transport-only headers and values derived from mutable database state are
  excluded. In particular, replay does not recalculate the hash from a later
  registry/anchor state, selected verification anchor, or normalized interface
  read from the stored record; those values belong to the committed result and
  observation. Replaying the same pair and identical semantic fingerprint
  returns that original result without a second observation, state transition,
  cascade, or audit event. A different operation or any different semantic
  request field for that actor+`submission_id` returns 409 with no mutation. The
  idempotency row is committed only with a successful mutation; malformed,
  oversized, signature-invalid, revoked-key-ID, authorization, CAS,
  conflict, and persistence failures create no new idempotency row and do not
  alter an existing successful replay row.
- The same canonical document submitted under a new `submission_id` appends an
  observation without changing state. Concurrent imports converge on one
  immutable document record while preserving each distinct successful
  observation; changed documents remain distinct discovered records.
- Revoking a trust anchor atomically revokes every currently `trusted` card
  record whose successful administrator decision depends on that anchor.
  Each cascade edge is recorded in the same transaction. Discovered and
  rejected records remain unchanged; a revoked record cannot be restored.
- The preferred A2A interface URL is normalized by exactly
  `new URL(url).href`, persisted as `preferred_interface_uri`, and used
  consistently for lookup, trust-conflict checks, and the trusted-record unique
  constraint. No second normalizer, display-name grouping, endpoint fallback,
  or last-write-wins rule may define interface identity.
- At most one `trusted` record may own the same normalized
  `preferred_interface_uri`. If an incumbent trusted record exists, trusting a
  different discovered record returns 409 and commits no registry mutation. The
  incumbent must be revoked through a separate administrator revoke request
  using its own `expected_version` and `submission_id`; the candidate trust is a
  later independent request. There is no replacement endpoint, implicit revoke,
  or compound swap. Registry reads expose the one trusted canonical interface
  or no interface.

##### Zero-effect boundary and later stages

- P4-2 performs no HTTP discovery, endpoint probe, `jku`/JWKS retrieval,
  credential lookup/provisioning, automatic trust-key lifecycle, health check,
  tool registration, remote invocation, or host routing. Persistence and
  administrator-triggered local mutations are its only effects. Every returned
  card/interface projection remains `routable=false`.
- The configured Agent Hub database transaction is P4-2's only I/O. P4-2
  performs zero network, filesystem, child-process, tool, or runner I/O; PEM
  public-key material and card documents cross the authenticated HTTP boundary
  as values, never as paths to be read. Tests inject seams that fail if any
  prohibited I/O path is touched.
- The next trust/connectivity stage owns HTTPS discovery, `jku`/JWKS and trust
  key automation, per-agent credentials, and endpoint-health lifecycle. Those
  operations must consume this registry through an explicit boundary and may
  not rewrite its historical evidence.
- A later remote-routing stage owns the only host↔Agent Hub route decision. It
  must require an independently eligible, healthy, credentialed registry
  interface and a host authorization path; neither `admissionTrustState` nor
  `registryState=trusted` alone is sufficient.
- Plugin/HostApi integration, Marketplace behavior, meeting and local-indexer
  work, and SDK dependency alignment are explicitly outside P4-2 and this A2A
  roadmap. They must not be introduced as hidden prerequisites or side effects.
- D8 remains unchanged: delegation creation stops at depth 1. P4-2 changes
  neither the local communication graph nor the creation graph.

##### P4-2 completion evidence

P4-2 is complete only when Agent Hub has durable migrations and tests proving:

1. restart-safe persistence of canonical documents, `payloadSha256` and
   `canonicalDocumentHash`, immutable per-submission admission/verification
   observations and provenance, administrator decisions, trust anchors, and
   append-only audit history;
2. exact state-transition enforcement, terminal-state non-revival, and the
   separation of observation-owned `admissionTrustState` from record-owned
   `registryState`, including proof that observation/import/re-verification does
   not change registry state; lifecycle-aware active+revoked policy input; and
   proof that a revoked `key_id` remains a known fail-closed admission denylist
   match with zero card, observation, audit, or idempotency persistence on
   failure, while a new unknown `key_id` is not fingerprint-inferred and may
   remain discovered before G003;
3. administrator-only authorization before every card, observation, audit, and
   trust-anchor read/write; transactionality; per-aggregate compare-and-swap;
   actor+`submission_id` replay/conflict behavior; zero new or altered
   idempotency rows for failed requests; and concurrent import/mutation safety;
4. explicit PEM trust-anchor validation and separation from signup identity;
   consistent host-minted numeric `id` versus administrator-supplied signature
   `key_id` roles in DB rows, responses, snapshots, create fingerprints, and
   revoke targets; canonical-fingerprint/key-ID lifetime uniqueness;
   duplicate-active 409; terminal revocation; revoked-fingerprint
   re-registration/revival denial; and rejection of re-registration under a new
   `key_id`, with raw private-key/PEM bytes absent from error responses,
   application logs, audit, observations, and idempotency rows;
5. atomic trust-anchor revocation cascade; exact `new URL(url).href`
   normalization; exactly one trusted record per normalized
   `preferred_interface_uri`; 409/no-mutation incumbent conflicts; and separate
   versioned incumbent revocation before a later candidate trust request;
6. deterministic restart/migration behavior; proof that system-generated audit
   metadata copies no credential, raw bearer, private key, card, PEM, signature,
   or protected-header material; and a bounded administrator decision reason as
   the only free-text field, without claiming arbitrary-secret detection;
   rejected card/PEM/private-key inputs return generic bounded errors with their
   raw bytes absent from API responses, application logs, and audit rows;
7. full-semantic-request idempotency fingerprints, including import provenance
   and every operation field, with 409 on any same-actor/submission mismatch;
   and contract tests proving every returned card/interface projection is
   `routable=false` and that the database is the only I/O—no network,
   filesystem, child-process, tool, runner, discovery, health, plugin,
   host-routing, or agent-execution seam is invoked.

Non-goals for P4-2 are discovery, JWKS/key automation, credentials, health
probing, routing, D8 changes, plugin registration, HostApi changes, Marketplace
activation, meeting/local-indexer work, and SDK alignment. Passing unrelated
plugin or host tests cannot substitute for the Agent Hub persistence,
concurrency, authorization, and zero-effect evidence above.

#### P4-3 / G003 trust-connectivity security contract (locked 2026-07-16)

P4-3 is the first bounded network-bearing stage and is owned entirely by Agent
Hub. `lvis-app` owns this contract and later documentation alignment only; it
adds no discovery client, credential resolver, health worker, remote route,
plugin branch, HostApi method, or renderer surface in P4-3. The desktop host
continues to own final execution authorization under the architecture v4
host-trust invariant. Agent Hub registry/discovery metadata evidence is only a
possible input to a later route decision, never permission to execute or a
claim that any advertised A2A interface is reachable or healthy.

The A2A release history includes a v1.0.1 tag, while the normative specification
heading available at lock time identifies v1.0.0 and specifies that patch
versions are not negotiated. P4-3 consequently locks the A2A `1.0` wire
contract and the official v1.0 discovery, JWS, and caching semantics. The patch
tag may clarify the text but cannot silently widen this security boundary.

##### First-slice ownership and entry point

- The first slice is an administrator-triggered operation against one explicit
  public origin. Agent Hub derives exactly
  `https://<origin>/.well-known/agent-card.json`; callers cannot supply an
  arbitrary path, query, fragment, username, password, scheme, or non-default
  port. Background scheduling and authenticated extended-card retrieval are
  deferred.
- One discovery target has a host-minted numeric `id` and one immutable,
  WHATWG-normalized public HTTPS origin protected by a database-wide unique
  constraint. Before that uniqueness check, its hostname undergoes the same
  WHATWG/IDNA ASCII conversion, lowercase normalization, and trailing-dot
  removal used for `jku`. The result must be the exact canonical HTTPS origin
  with effective port 443, from which Agent Hub alone derives
  `https://<canonical-host>/.well-known/agent-card.json`. Target creation
  performs zero network I/O. Concurrent or different-submission creates for the
  same normalized origin converge on the same target or return a bounded 409;
  they never create duplicate target, cache, metadata-health, or key namespaces.
  Discovery and revalidation accept only the numeric target `id`,
  `expected_version`, and `submission_id`; the origin is never editable or
  caller-overridable after creation.
- Target disable is an employee-administrator CAS mutation. It returns 409 with
  zero mutation while any operation lease for that target is running. A
  successful disable increments target `row_version`; disabled targets reject
  new discovery or revalidation claims. Discovery/revalidation completion,
  including health, cache, or attempt persistence, never changes target
  `row_version`.
- The public well-known Card and a same-origin `jku` JWKS are fetched without
  credentials. P4-3 never sends `Authorization`, cookies, proxy credentials,
  client certificates, or another ambient secret. A protected or authenticated
  endpoint fails closed in this slice instead of falling back to another fetch
  path.
- Every P4-3 card, discovery, key-revision, credential-reference, health, and
  audit read or write is administrator-only. The existing bounded credential
  lookup is allowed and required to authenticate the caller. Authentication,
  employee-administrator authorization, and complete request validation then
  finish before any P4-3 target or domain-repository lookup, existence
  disclosure, idempotency claim, lease, mutation, DNS lookup, or socket creation.
- Human administrators and host-created system principals are different
  principal kinds with different identifiers and scopes. The durable principal
  row has an `employee | system` kind check and exactly one matching identity;
  no fake employee represents a system. Every operation and lease records a
  non-null, immutable `requested_by_employee_id` for the initiating employee
  administrator. `executed_by_principal_id` is that administrator at claim and
  may change only to the system principal that wins fenced recovery of the same
  already-authorized expired lease; recovery never clears, rewrites, or
  substitutes the original requester. Administrator endpoints accept employee
  principals only. A system principal cannot originate an operation and may
  only recover an already-authorized expired lease; it cannot create a discovery
  target, approve trust, activate a key, provision a credential reference, or
  start an unrequested background job. Employee signup identity, Agent Card
  signing keys, and trust anchors remain separate namespaces.

##### One fail-closed HTTPS fetcher

Card and JWKS retrieval use one injected Agent Hub fetcher. Direct `fetch`, a
second HTTP client, proxy-environment inheritance, or caller-supplied transport
options are prohibited.

- Parse and serialize with the WHATWG `URL` implementation. The only allowed
  scheme is `https:` and the only allowed port is the default 443. The hostname
  used for DNS, the HTTP `Host` field, TLS SNI, and certificate identity remains
  the original normalized hostname; it is never replaced by an IP literal.
- Resolve all A and AAAA answers before connecting. The resolver must return 1-8
  unique addresses, every address must be a fully validated public unicast
  address, and the complete effective set must be known. A NODATA result for one
  family is allowed only when the other family succeeds; timeout, truncation,
  contradictory resolver results, or any other indeterminate family result
  fails closed. Classification rejects every IANA special-purpose prefix,
  including loopback, private, link-local, shared, translated, tunneled, mapped,
  multicast, unspecified, documentation, benchmark, and reserved space.
  Embedded IPv4 is extracted and classified before accepting an IPv6 answer.
  Any duplicate answer or mixed public/non-public answer rejects the entire
  request.
- The socket is pinned through an injected `lookup`/connection hook to one of
  the already validated answers. The network client must not resolve the name a
  second time. The client preserves resolver order and attempts each approved
  address at most once, sequentially, under the one shared five-second deadline.
  Every attempt uses a fresh non-reusable socket; failure closes it before the
  next approved address is tried. The custom socket lookup returns the selected
  exact address once and never invokes ambient resolution. The canonical
  hostname remains the HTTP `Host`, TLS SNI, and RFC 9525 certificate service
  identity on every attempt. There is no re-resolution, parallel racing,
  connection reuse, or proxy path. The transport constructor is the only test
  seam; production callers cannot inject a resolver, socket, agent, proxy, CA,
  or TLS option.
- Redirect budget is exactly zero. Every 3xx response, including a same-origin
  redirect, is a bounded failure. There is no HTTP downgrade, Location recovery,
  alternate well-known path, or last-known-good network fallback.
- One monotonic five-second deadline covers DNS, connect, TLS, response headers,
  and body. Timeout, cancellation, or any rejected response destroys the
  request, closes the socket, and prevents connection reuse. Response
  headers are capped at 16 KiB and the decoded body at 64 KiB; `Content-Length`
  is prechecked but never trusted as the streaming limit.
- Requests send `Accept-Encoding: identity`. A response with any non-identity
  `Content-Encoding` is rejected, preventing a compressed body from bypassing
  the 64 KiB bound. Only status 200 is accepted for a first fetch; a conditional
  revalidation may also accept 304 under the cache rules below.
- TLS uses the platform trust store, `rejectUnauthorized=true`, an explicit
  minimum of TLS 1.2, original-hostname certificate verification, and no custom
  CA, pin bypass, wildcard relaxation, insecure development mode, or
  environment-controlled proxy. TLS 1.3 is preferred when negotiated.
- A 200 response must use `application/json` or `application/*+json` and contain
  valid UTF-8. The transport hashes the exact response-byte sequence, including
  any BOM, before decoding; the decoded UTF-8 view exists only for strict JSON
  parsing and P4-1 admission. Duplicate keys, comments, trailing data,
  non-finite numbers, or a top-level non-object are rejected. In addition to the
  64 KiB byte limit, the parser caps nesting depth at 32, total JSON nodes at
  4,096, object members at 256 per object, and array items at 1,024 per array.
  Any JSON syntax, duplicate-key, shape, or structural-bound failure returns the
  fixed `json-rejected` outcome before P4-1 admission.

##### Discovery, JWS, and JWKS trust boundary

- The fetched Card is passed unchanged through the existing P4-1 bounded
  admission and canonicalization contract. Network success is not admission;
  admission success is not administrator trust; administrator trust is not
  connectivity health; and none of those states is routing.
- A protected `jku` is eligible for observation only when it is an absolute
  HTTPS URL with no userinfo or fragment, default port 443, and exactly the same
  canonical origin as the well-known Card. Its path and query are allowed; they
  do not change origin identity. Before comparing, both hostnames undergo the
  same WHATWG/IDNA ASCII normalization, lowercase conversion, and trailing-dot
  removal. Relative URLs, origin drift after canonicalization, non-default
  ports, redirects, fragments, userinfo, or credentialed JWKS retrieval are
  rejected.
- JWKS parsing follows the JWS/JWK algorithm-verification model and an explicit
  allowlist. At most 32 unique `kid` entries are accepted. `ES256` requires an
  EC P-256 public verification key; `EdDSA` requires an OKP Ed25519 public
  verification key. `alg`, when present, must equal the reviewed algorithm;
  `use`, when present, must be `sig`; `key_ops`, when present, must contain
  `verify`; private-key members and duplicate `kid` values reject the document.
  The JOSE `alg`, `kid`, `jku`, `crit`, and `b64` parameters are protected-only;
  their unprotected appearance or any duplicate protected/unprotected parameter
  name rejects the signature. P4-3 supports no critical extension, so `crit`
  must be absent and `b64` must be absent or `true`. Embedded `jwk`, `x5u`,
  `x5c`, and every other key source are rejected. Algorithm inference, `none`,
  HMAC, RSA, other curves, and recursive key retrieval are prohibited.
- Signature/key/payload mismatch is a fixed failed-attempt outcome. It creates
  no Card import, key revision, anchor, registry-state change, or other trust
  mutation.
- A key from the Card's own `jku` is self-asserted evidence. Fetching it and even
  verifying the Card with it creates only an immutable key observation and a
  candidate revision; it never creates or activates a P4-2 trust anchor, never
  changes `registryState`, and never changes `routable=false`. The same `kid`
  with different canonical public-key bytes creates a new immutable observed
  revision and always appends an explicit key-material-mismatch security finding
  plus redacted audit row. It never updates or replaces the earlier revision and
  is never automatically promoted, linked, or activated.
- The only key-revision transitions are `observed -> active -> revoked`;
  revoked is terminal and no revision can reactivate. `linked_trust_anchor_id`
  is unique. Activation names one exact immutable stored revision and atomically
  creates and links the P4-2 anchor for those exact canonical public-key bytes.
  A same-`kid` replacement is a different observed revision and cannot inherit
  the link or trust decision. Only an authenticated employee administrator may
  activate or revoke, using the revision's numeric `id`, `expected_version`,
  `submission_id`, and a bounded decision reason.
- Revocation locks the active revision and linked anchor, changes the revision
  to `revoked`, executes the existing P4-2 anchor revocation and dependent
  trusted-card cascade exactly once, and commits audit plus the idempotent result
  in the same transaction. The revoked anchor is ineligible for every future
  P4-1/P4-2 verification and cannot be replaced or revived. Rotation activates
  the replacement revision before a separate CAS revocation of the incumbent.
  Non-cascading planned retirement is deferred until a later P4-2 lifecycle
  extension can represent a non-verifying, non-revoked anchor state. P4-3 has no
  `retired` API or database value. JWKS disappearance never mutates lifecycle,
  and the lifetime `key_id`/fingerprint denylist remains authoritative.
- A P4-2 trust anchor referenced by a P4-3 `linked_trust_anchor_id` is
  revision-managed. The existing P4-2 direct anchor-revocation endpoint locks
  and checks that relationship and returns 409 with zero mutation when the
  anchor is linked; it remains available only for unlinked legacy anchors. Only
  P4-3 revision revocation may lock and CAS the linked revision plus anchor and
  invoke the shared P4-2 dependent-card cascade once in the same transaction.
  Direct and revision revocation use the same lock order, so no concurrent path
  can commit an `active` revision whose linked anchor is `revoked` or run the
  cascade twice.
- A 200 response with a changed canonical Card is submitted through the existing
  P4-2 import path as a distinct `registryState=discovered` record. It never
  edits the incumbent document in place and never transfers trust. Administrator
  review remains a separate request.

##### Credential references, attempts, and Agent Card/JWKS metadata-endpoint health

- P4-3 persists credential metadata only as an opaque secret-manager reference:
  provider, reference, external version, intended origin, lifecycle state, row
  version, and audit metadata. Raw bearer values, refresh tokens, client
  secrets, private keys, or encrypted secret blobs never cross the Agent Hub API
  and never enter its database, logs, audit, observations, or idempotency rows.
- `secret_reference` is opaque and is never dereferenced, validated against a
  remote secret manager, included in an outbound request, or copied to an error,
  log, audit row, observation, or idempotency response. Credential-reference
  lifecycle is `active -> revoked` and revoked is terminal. Rotation is one
  administrator CAS transaction that creates a new active reference and revokes
  the incumbent; it never edits a reference in place. Secret resolution, remote
  credential use, and authenticated extended-card fetch require a later contract.
- Credential create or rotation requires an active target and an
  `intended_origin` exactly equal to that target's immutable canonical origin;
  credential revocation remains allowed after target disable. Each credential
  binding's `active_revision_id` must reference an `active` revision belonging
  to the same binding. Database foreign-key/check and unique constraints enforce
  that relationship and exactly one active revision per binding in both SQLite
  and PostgreSQL.
- A secret-reference fingerprint is only a non-reversible `HMAC-SHA-256` audit
  token computed with a dedicated server-only audit key. A raw or deterministic
  SHA digest, raw reference, or any unkeyed derivative never enters an API
  response, audit row, application log, observation, or idempotency record. Only
  the keyed token may be retained internally for credential metadata, audit, and
  idempotency correlation, and it is never returned to callers. Every credential
  create, rotate, revoke, or replay path fails closed before mutation when the
  audit key is unavailable; there is no unkeyed, plaintext, random-token, or
  skip-audit fallback.
- After the allowed bounded credential lookup, administrator authentication,
  employee-administrator authorization, and complete request validation, Agent
  Hub atomically claims the database-wide unique key
  `(requested_by_employee_id, submission_id)`, creates one mutable operation
  lease with a monotonically increasing fence token, and then begins network I/O.
  `requested_by_employee_id` is the immutable initiating employee identity, not
  an employee-principal ID or `executed_by_principal_id`. Failed
  authentication, authorization, or malformed input performs no P4-3 target or
  domain-repository lookup, idempotency/lease/domain mutation, DNS lookup, or
  socket creation. Exact completed replay returns the stored result with zero
  I/O and zero mutation; a semantic mismatch returns 409 before I/O.
- The mutable lease names `requested_by_employee_id`,
  `executed_by_principal_id`, owner, expiry, row version, and fence token.
  `requested_by_employee_id` is non-null and immutable for the lease lifetime;
  `executed_by_principal_id` starts as that employee administrator and changes
  only when the system principal wins recovery. Only a system principal may
  recover an expired lease; it cannot originate one. Completion is conditional
  on the current fence; a late owner cannot append evidence, audit, health, or
  an idempotent result. The newer fence always wins.
- Only the outcome-to-health table below may create endpoint evidence. A mapped
  network or representation result atomically appends one immutable discovery
  attempt and exactly one immutable metadata-health observation under the
  current fence, together with the fixed outcome, redacted audit row, completed
  idempotent response, and lease release. A failure persists no Card, P4-2
  import, key revision, credential-reference change, reusable cache
  representation or validator, or trust mutation.

  | Fixed outcome or accepted result | Discovery attempt | Metadata health |
  | --- | --- | --- |
  | `dns-rejected`, `connect-rejected`, `tls-rejected`, `redirect-rejected`, `http-rejected`, `timeout` | exactly one | `unreachable` |
  | `headers-too-large`, `body-too-large`, `content-rejected` including compression/MIME/UTF-8, `json-rejected`, `card-rejected`, `jwks-rejected` | exactly one | `invalid` |
  | `cache-miss`, `stale-version`, `persistence-failed`, or any post-claim pre-network domain failure | none | none |
  | accepted 200 or eligible 304 whose validation and P4-2 transaction commit | exactly one | `healthy` |

- A successful accepted-200 or eligible-304 discovery/revalidation atomically
  commits the terminal attempt, bounded transport evidence, P4-2 import result,
  corresponding `healthy` metadata-health observation, audit, completed
  idempotent response, and lease release. Attempt evidence may contain
  normalized origin, timing
  buckets, body hashes, TLS protocol, certificate fingerprint, selected public
  address, allowlisted cache validators, and a fixed outcome code; it never
  contains response bodies, credentials, secret references, PEM/JWK bytes, raw
  signatures, protected headers, private/special-use IPs, raw OS/TLS errors, or
  arbitrary response headers.
- Agent Card/JWKS metadata-endpoint health is an observation-owned axis separate
  from P4-2
  `admissionTrustState`, administrator-owned `registryState`, and key lifecycle.
  It is derived solely from fetch, validation, and revalidation of
  `/.well-known/agent-card.json` and an accepted same-origin JWKS. Manual
  revalidation of an existing target may append an immutable health observation
  (`healthy`, `unreachable`, or `invalid`) without
  rewriting any earlier discovery, verification, trust, or audit row. It does
  not prove `supportedInterfaces[].url` reachability, readiness, authentication,
  conformance, or routability and is not service, A2A-operation, or credential
  health. `HEAD`, `OPTIONS`, TLS-only, and A2A method probes against an
  advertised interface are rejected as non-standard scope widening. Advertised-
  interface smoke belongs to G005 only if that goal is later enabled. `unknown`
  means no endpoint attempt from the table has been committed. `healthy`
  requires an accepted 200 or eligible 304 whose validation and P4-2 transaction
  committed. `unreachable` and `invalid` are assigned only by the exact table;
  in particular local `cache-miss`, concurrency/version, pre-network domain, and
  persistence outcomes never fabricate endpoint evidence. `degraded` is not a
  P4-3 state. `stale` is derived on read only after prior `healthy` evidence
  expires and is never persisted by a timer; a mapped failed revalidation
  instead appends its explicit `unreachable` or `invalid` observation. Late
  fenced results cannot replace a newer snapshot. No health state changes trust
  and no trust state changes health.
- Every returned Card, interface, key, credential-reference, and health
  projection remains `routable=false`. P4-3 performs no A2A JSON-RPC operation,
  task creation, tool registration, remote invocation, local runner call, host
  authorization, or route selection.

##### Cache, idempotency, concurrency, and audit

- A cacheable 200 may persist exactly one dedicated, bounded, immutable raw
  representation blob as SQLite `BLOB` or PostgreSQL `BYTEA`, its SHA-256 digest,
  and only bounded `ETag`, `Last-Modified`, `Date`, and `Cache-Control` metadata.
  The blob and digest cover the exact response bytes, including any BOM; decoded
  UTF-8 is a parsing view and is never a reconstructed cache representation.
  Terminal attempts and metadata-health observations contain only the digest and
  bounded diagnostics, never the body. A manual revalidation sends conditional
  headers only to the exact same normalized origin. A 304 is accepted only when
  an eligible prior cache blob exists; it re-hashes those exact immutable bytes,
  requires equality with the stored digest, and re-verifies them against the
  current active-anchor policy before a new healthy snapshot can commit. The
  transaction may append one verification and one terminal attempt/metadata-
  health observation, but never duplicates the Card document, registry record,
  or key revision. A missing or hash-mismatched blob fails closed as
  `cache-miss`. The P4-2 canonical business record, canonical Card, and key
  observations are never reconstruction or cache fallbacks.
- Before the claimed operation's final transaction, duplicate `ETag` or
  `Last-Modified` fields fail terminally as `http-rejected` with no cache
  mutation. One `ETag` is bounded to 1,024 bytes and one `Last-Modified` to 256
  bytes. A fresh 200 replaces each stored validator with the received bounded
  value or clears it when absent. Only an accepted 304 retains an absent prior
  validator and merges a received bounded replacement. Multiple `Cache-Control`
  fields may be combined only when every freshness directive is syntactically
  valid and unambiguous.
- Each healthy metadata snapshot persists `committed_at` and computes
  `effective_fresh_until = committed_at + min(valid max-age, 15 minutes)`.
  `max-age=0` produces zero freshness; an absent `Cache-Control` or absent
  `max-age` defaults to five minutes. A syntactically invalid directive or
  conflicting/duplicate freshness directive produces effective freshness zero,
  never the five-minute default. `no-cache` forces freshness to zero and
  requires revalidation. `no-store` persists neither a reusable representation
  blob nor validators or other reusable cache metadata and also forces freshness
  to zero; its snapshot may retain only the digest and bounded non-reusable
  diagnostics. The HTTP `Date` value is diagnostic only and never a clock
  source. An accepted 304 uses the same calculation for its newly committed
  healthy snapshot. `stale` is true only when the latest metadata-health
  observation is `healthy` and `now >= effective_fresh_until`.
- The separately required P4-2 canonical business record and trust evidence are
  not an HTTP cache. The first slice has no automatic scheduler and never
  converts freshness into trust.
- Every discovery, manual revalidation, key-revision mutation, and
  credential-reference mutation uses the canonical idempotency key
  `(requested_by_employee_id, submission_id)`, matching P4-2's global
  per-employee submission namespace. Its row stores immutable `operation_kind`
  and `semantic_request_hash`; the latter includes normalized origin or numeric
  target, `expected_version`, and every accepted request field. Lookup compares
  both stored values before replay. Any operation-kind or semantic-hash mismatch
  returns 409 with zero P4-3 lookup beyond the idempotency row, lease/mutation,
  audit, attempt, health, DNS, socket, or other side effect. Fenced system
  recovery retains the employee-owned key while `executed_by_principal_id`
  records the recovery executor. Exact success or failure replay returns the
  committed result without network I/O, audit, attempt, lease, or state
  mutation. Only authentication and pre-claim validation failures create no
  idempotency row.
- Expected post-claim, pre-network domain failures—including target-not-found
  404, disabled/stale-version/conflict 409, and invalid-stored-target 422—commit
  only an operation-terminal fixed outcome, redacted audit row, completed
  idempotent response, and lease release. They create no discovery attempt,
  metadata-health observation, business record, cache entry or validator, key
  observation/revision, credential mutation, or outbound I/O. The target remains
  `unknown` when it has no earlier outbound terminal attempt.
- Mutable target, key-revision, and credential-reference aggregates use
  per-aggregate compare-and-swap. State change, immutable evidence, audit, and
  successful idempotency result commit in one database transaction. Concurrent
  distinct mutations have one winner; losers return bounded stale/conflict
  errors with no partial persistence. An unexpected finalization persistence
  failure first rolls back the terminal attempt, metadata-health observation,
  audit, domain changes, and completed idempotent response together. Agent Hub
  then makes one best-effort minimal transaction to store terminal
  `persistence-failed`, redacted audit, and the replayable fixed response while
  releasing the lease. This infrastructure terminalization is not a successful
  discovery/revalidation completion, creates no discovery attempt,
  metadata-health observation, or trust/cache/domain evidence, and never
  converts uncommitted remote evidence into health. If the database failure also
  prevents that minimal transaction,
  the claim remains fenced and `running`; the winning system recovery later
  terminalizes it as `persistence-failed` without new DNS, socket, HTTP, JWKS,
  secret-manager, or other outbound I/O.
- Audit is append-only and principal-aware. It distinguishes human and system
  actors, records bounded reason and before/after state, and never treats
  employee signup keys, Agent Card keys, secret-manager references, or bearer
  credentials as interchangeable identities. Persistent error outcomes use only
  this fixed enum: `dns-rejected`, `connect-rejected`, `tls-rejected`,
  `redirect-rejected`, `http-rejected`, `timeout`, `headers-too-large`,
  `body-too-large`, `content-rejected`, `json-rejected`, `card-rejected`,
  `jwks-rejected`, `cache-miss`, `stale-version`, or `persistence-failed`. TCP
  connection refused, reset, or connect failure maps to `connect-rejected`; 3xx
  maps to `redirect-rejected`; every other non-200/304 status maps to
  `http-rejected`. The mapping covers every terminal DNS, connection, TLS,
  timeout, redirect, HTTP, size, JSON, and content failure without overloading
  TLS or content codes. No raw OS, resolver, socket, TLS, actual HTTP status or
  body, header, URL credential, or private-address value is copied into an API
  response, log, audit row, attempt, metadata-health observation, or idempotency
  record. The actual HTTP status is never persisted or returned; callers receive
  only the fixed outcome and bounded message.

##### Deferred and excluded work

- Deferred beyond the first P4-3 slice: background scheduling, retry workers,
  authenticated extended Agent Card fetch, secret-manager resolution, remote
  credential use, cross-origin JWKS policy, private-network discovery, endpoint
  application probes, advertised-interface smoke, and every host↔Agent Hub route
  or invocation. Advertised-interface smoke belongs to G005 only if that goal is
  later enabled.
- Plugin/HostApi integration, Marketplace behavior, meeting, local-indexer,
  plugin-SDK dependency alignment, and any `lvis-app` runtime change are
  excluded. They are neither prerequisites nor acceptable substitutes for
  Agent Hub security evidence.
- D8 is unchanged: delegation creation stops at depth 1. P4-3 changes neither
  the local communication graph nor the creation graph.

##### P4-3 normative completion matrix

| Gate | Required evidence |
| --- | --- |
| Ownership | Agent Hub-only runtime diff; `lvis-app` diff is documentation-only |
| Admin boundary | the existing bounded credential lookup is the only allowed pre-auth repository access; authentication, employee-admin authorization, and complete validation precede every P4-3 target/domain lookup, existence disclosure, idempotency/lease/mutation, DNS, and socket operation |
| Principal separation | human/system principals have distinct IDs, scopes, and schema checks; immutable non-null employee requester survives fenced system recovery while execution attribution changes to the winning system principal |
| Target identity | host-minted numeric ID plus immutable unique public HTTPS origin whose hostname uses the same WHATWG/IDNA ASCII, lowercase, and trailing-dot removal as `jku`; effective port is 443 and the exact well-known URL is host-derived; create has zero network I/O; same-origin concurrency never forks namespaces; disable returns zero-mutation 409 with a running lease, otherwise CAS-increments target version while discovery completion never does |
| Fetch limits | HTTPS/443, redirect 0, one 5 s deadline, 16 KiB headers, 64 KiB body, identity encoding |
| SSRF | 1-8 unique fully public A/AAAA answers, mixed/duplicate rejection, resolver-order sequential once-only attempts under one 5 s deadline, fresh, non-reused sockets, canonical SNI/Host, no re-resolution or proxy |
| TLS | platform roots, minimum TLS 1.2, RFC 9525 hostname verification, no insecure override |
| Admission | exact response bytes are hashed including BOM, decoded only for strict UTF-8 JSON parsing, bounded at depth 32/nodes 4,096/object members 256/array items 1,024, then passed to existing P4-1 before any durable success commit |
| JOSE/JWKS | protected-only `alg`/`kid`/`jku`/`crit`/`b64`; protected same-origin `jku` may contain query but no fragment/userinfo/nondefault port/origin drift after IDNA/lowercase/trailing-dot canonicalization; maximum 32 keys; exact ES256/P-256 and EdDSA/Ed25519 checks |
| Trust lifecycle | self-JWKS stays observed; changed same-`kid` material always creates a new observed revision plus security finding/audit and never auto-promotes; exact revision/anchor activation; linked anchors reject direct P4-2 revoke with zero-mutation 409; only P4-3 revision revoke CASes both and cascades once; no active-revision/revoked-anchor split; no `retired` value |
| Credentials | opaque reference only; `active -> revoked`; create/rotate requires active target, exact canonical intended origin, same-binding active revision, and exactly one DB-enforced active revision; revoke allowed when disabled; reference correlation uses only dedicated-key HMAC-SHA-256 and fails closed when the key is unavailable |
| Operations | database-wide unique idempotency key `(requested_by_employee_id, submission_id)` with immutable stored `operation_kind` and `semantic_request_hash`; any mismatch is zero-effect 409 and executor principal is attribution only; pre-network post-claim 404/409/422 records only operation terminal/audit/replay and no attempt/health/domain mutation; only exact mapped endpoint outcomes record one attempt plus exactly one fenced health; late-owner suppression and fixed errors; unrecoverable finalization uses best-effort no-attempt/no-health `persistence-failed` and otherwise leaves a running fenced lease for zero-outbound system terminalization |
| Agent Card/JWKS metadata-endpoint health | DNS/connect/TLS/redirect/HTTP/timeout outcomes are `unreachable`; header/body/content including compression/MIME/UTF-8, JSON, Card, or JWKS rejection is `invalid`; cache miss, stale version, persistence failure, and all pre-network domain failures create no attempt/health; accepted 200/304 plus P4-2 commit is `healthy`; `unknown` iff no mapped endpoint attempt exists; `stale` is read-derived after prior healthy expiry; no `degraded` state; proves no advertised-interface reachability/readiness/authentication/conformance/routability and performs no interface probe |
| Evidence | immutable discovery/metadata-health/audit rows remain separate from admission, registry trust, and advertised-interface health |
| Cache | exact raw SQLite BLOB/PostgreSQL BYTEA plus SHA-256 and allowlisted validators; duplicate/oversized validator rejection, 200 replace-or-clear, 304 retain-or-merge and exact-blob re-hash/current-anchor verification; no reconstruction; freshness 0/5-minute default/15-minute cap, invalid/conflicting directives zero, `Date` ignored, `no-cache`/`no-store` zero and `no-store` persists no blob/validator |
| Failure taxonomy | deterministic fixed mapping includes `json-rejected`, `connect-rejected`, and `http-rejected`; actual HTTP status and raw OS/TLS/status/body evidence are never persisted or returned |
| Transactions | success/failure replay is zero-I/O, mismatch 409, CAS/fence winner, fixed failure outcome plus one fenced health observation for classifiable completions, all-or-nothing domain finalization, best-effort infrastructure terminalization with no fabricated health |
| Database parity | identical SQLite/PostgreSQL BLOB/BYTEA, unique target origin, credential binding/active-revision, CAS, and transaction semantics; configured PostgreSQL suite has zero skips |
| Regression | existing P4-1/P4-2 semantic, lifecycle, replay, cascade, and `routable=false` suites remain green |
| No execution | every projection is `routable=false`; no task, tool, runner, plugin, host route, or invocation |

The attack-test acceptance set must prove at least: loopback/private/link-local/
metadata, duplicate-answer, and mixed DNS rejection; DNS rebinding resistance;
preserved resolver order, sequential once-only address attempts, fresh socket per
attempt, one shared deadline, and no re-resolution/proxy; IP-literal, userinfo,
fragment, port, HTTP, redirect, proxy, timeout, oversized-header, oversized-body,
compressed-body, non-JSON MIME, invalid UTF-8, duplicate-key, depth 33, node
4,097, object-member 257, and array-item 1,025 rejection as `json-rejected`
where applicable, with exact-boundary acceptance;
wrong-host, expired, self-signed, TLS 1.1, and SNI/certificate mismatch rejection;
cross-origin/redirected/oversized/duplicate-`kid`/private-key/algorithm-confusion
JWKS rejection; protected same-origin `jku` query acceptance; IDNA, case, and
trailing-dot equivalence; userinfo/fragment/nondefault-port/origin-drift
rejection; self-JWKS non-promotion; same-`kid` changed-material isolation with a
new observed revision and explicit security finding/audit on every change, with
no auto-promotion; key/payload mismatch with no trust mutation; revoked-key non-
revival; secret and reference non-leakage; database-wide unique employee-ID plus
submission-ID idempotency ownership across administrator execution and fenced
system recovery; immutable stored operation/hash comparison; operation/hash
mismatch 409 with zero P4-3 side effect or I/O; and proof that executor principal
ID never substitutes into that key; HMAC-SHA-256 reference-token stability
under one audit key, non-equivalence across keys, absence of raw/unkeyed
derivatives, and fail-closed credential APIs when the audit key is unavailable;
credential create/rotate rejection for disabled target, origin mismatch,
cross-binding/non-active revision, or second active revision, plus revoke on a
disabled target; unauthorized/malformed requests performing only the
bounded credential lookup and zero P4-3 target/domain-repository lookup,
idempotency/lease/domain mutation, DNS, or socket operation; non-null immutable
requester schema checks, administrator execution attribution, fenced system-
recovery attribution, and audit preservation; success and failure replay with no
new I/O/audit/attempt; CAS concurrency; lease expiry, fenced recovery, and late-
owner suppression; target-disable 409/zero-mutation during a running lease,
successful disable row-version increment, and no target-version change from
discovery completion; expected pre-network post-claim 404/409/422 terminal
replay with zero discovery attempt, metadata-health, business/cache/key/
credential mutation, or outbound I/O; domain-finalization rollback; best-effort
no-attempt/no-health `persistence-failed`; and database-failure retained running
lease followed by fenced system terminalization with zero new outbound I/O;
linked-anchor direct-revoke 409 with zero mutation, concurrent
direct/revision revocation, exactly-once cascade, and impossibility of an active
revision with a revoked linked anchor; exact BLOB/BYTEA response bytes and
SHA-256 including BOM; decoded-view non-reconstruction; cache-body hash tamper,
missing-blob, and business-record reconstruction rejection; duplicate `ETag` or
`Last-Modified` as terminal `http-rejected` with no cache mutation; 1,024/256-
byte validator boundaries; 200 validator replace-or-clear; 304 validator retain-
or-merge plus exact-blob re-hash/current-anchor re-verification and no-body
failure; unambiguous multi-field `Cache-Control` combination; invalid or
conflicting/duplicate freshness directives forcing zero freshness; freshness
boundaries at zero, five-minute default, and fifteen-minute cap; skewed `Date`
ignored; `no-cache` and `no-store` freshness zero; `no-store` blob/validator
non-persistence;
metadata-endpoint healthy only after P4-2 commit; proof that no advertised-
interface `HEAD`, `OPTIONS`, TLS-only, or A2A method probe occurs;
exact outcome-table mapping of DNS/connect/TLS/redirect/HTTP/timeout to one
`unreachable` attempt, header/body/content/JSON/Card/JWKS rejection to one
`invalid` attempt, accepted 200/304 plus P4-2 commit to one `healthy` attempt,
and cache-miss/stale-version/persistence/pre-network-domain outcomes to no
attempt or health; `unknown` iff no mapped endpoint attempt exists; stale-on-
expired-healthy derivation; absence of a `degraded` state;
deterministic TCP refused/reset/connect and non-200/304 HTTP outcome mapping with
no raw OS/status/body persistence or return of the actual HTTP status; zero-
network target creation; target-host IDNA ASCII/lowercase/trailing-dot
equivalence before DB uniqueness; exact host-derived HTTPS/443 well-known URL;
immutable-origin enforcement; and concurrent same-origin create parity in SQLite
and PostgreSQL;
`routable=false`; zero-skipped PostgreSQL gates; existing P4-1/P4-2 regressions;
and absence of plugin, HostApi, runner, tool, route, advertised-interface health,
or remote-invocation effects.

#### P4-5 / G005 direct remote-routing contract (proposed for owner acceptance 2026-07-16)

P4-5 adds an opt-in route from the host-owned A2A client to an independently
operated remote A2A server. Agent Hub is the administrator-reviewed control
plane for route eligibility. It is not an A2A Task proxy, broker, or transcript
store. This boundary is deliberate: administrative discovery and policy remain
centralized while prompts, Parts, artifacts, Task responses, and credentials
stay on the direct A2A data-plane connection between the two hosts.

##### Control plane, data plane, and route identity

- **Direct data plane only:** the packaged LVIS host obtains one immutable route
  snapshot from Agent Hub and sends A2A requests directly to the exact
  `supportedInterfaces[]` URL named by that snapshot. Agent Hub never relays,
  terminates, queues, retries, inspects, or stores an A2A request or response.
  Task prompts, message Parts, artifacts, status messages, context IDs, remote
  Task IDs, and bearer values never cross the Agent Hub API.
- **Agent Hub control plane only:** Agent Hub authenticates the host runtime,
  applies the administrator-owned route policy, and returns a bounded route
  snapshot. Snapshot issuance is an authorization decision record, not proof
  that the caller may execute a Task and not a substitute for the foreground
  approval described below.
- **Exact immutable route:** a snapshot identifies one `targetAgentId`, one
  accepted `agentCardDigestSha256`, one advertised interface and canonical public
  HTTPS `interfaceUrl`, one active `trustKeyId`, one active credential revision by
  `credentialBindingId`/`credentialRevisionId` plus the authenticated
  `callerGenerationId` and bounded non-secret version, provider, and
  `external_version` metadata, one advertised-interface health observation, one
  `routePolicyVersion` plus `routePolicyDigestSha256`, and the verified canonical
  LVIS exact-send-replay
  extension identifier
  `https://lvis.ai/a2a/extensions/exact-send-replay/v1`. The checked-in
  [exact-send-replay profile](../protocols/lvis-a2a-exact-send-replay.md) is
  normative for implementation, but live route eligibility is forbidden until
  the identical specification is served at that exact URI and its published
  SHA-256 digest is pinned by both Agent Hub route policy and the packaged
  client. The snapshot carries that pinned digest as
  `extensionSpecDigestSha256`, plus a control-plane-minted snapshot ID and finite
  expiry. `secret_reference`, raw
  reference derivatives, and secret values are never snapshot fields.
  The client validates the complete shape and exact versions before any secret
  lookup or data-plane I/O. Missing, duplicated, ambiguous, expired, or changed
  fields make the snapshot ineligible.
- **Eligibility is conjunctive:** `trusted` admission alone is never routable.
  Agent Hub may mark the exact snapshot eligible only while the registry target
  is active, the exact key revision is active and bound to that target/card, the
  exact credential revision is active and bound to that target/interface, the
  exact advertised interface has a current healthy observation, and an explicit
  route policy authorizes the requesting host and operation class. The first
  slice additionally requires the exact-send-replay extension contract below.
  Every term must remain independently represented; no broad `trusted` or
  `healthy` alias may collapse them.
- **No route substitution:** the immutable lineage tuple is exactly
  (`targetAgentId`, canonical exact `interfaceUrl`, `agentCardDigestSha256`,
  `trustKeyId`, `credentialBindingId`, `callerGenerationId`,
  `routePolicyVersion`, `routePolicyDigestSha256`,
  `extensionSpecDigestSha256`). The client pins that complete tuple for the Task
  lineage and never chooses another interface, target, binding, caller
  generation, key, Card, policy, extension specification, or local sub-agent,
  and never asks Agent Hub for an automatic alternate after validation, network,
  authentication, timeout, or remote Task failure. Only prompt-free `GetTask`
  and an already-approved exact initial-Send replay may select a different active
  `credentialRevisionId`, and only while `credentialBindingId`,
  `callerGenerationId`, and every other immutable-lineage field remain exact.
  Every new mutation requires a new explicit request and foreground approval,
  including one that intends a different credential revision in the same
  binding. Revision succession is journaled separately and never migrates the
  Task to another route.

The first lvis-app slice consumes this generic control-plane contract through a
host-owned interface. Live source must not hard-code an Agent Hub plugin ID,
plugin tool name, HostApi method, or Marketplace route. Agent Hub is one service
implementation of the control plane, not an in-process plugin dependency.

Before P4-5 may consume extension declarations, the pure P4-1 parser expands its
strict `capabilities` schema with an optional `extensions` array. Admission
accepts at most 16 entries and rejects duplicate canonical URIs. Each entry is a
strict `AgentExtension`: an absolute HTTPS `uri` of at most 2,048 UTF-8 bytes, an
optional 512-byte `description`, an optional boolean `required`, and an optional
plain-object `params`. Parameters are bounded to 4,096 canonical UTF-8 bytes,
depth 4, 64 total values, 32 members per object or items per array, 128-byte
member names, and 2,048-byte strings; only strings, booleans, arrays, and plain
objects are admitted. Null, numbers, accessors, cycles, non-plain prototypes,
control characters, unpaired surrogates, duplicate keys, and dangerous member
names (`__proto__`, `prototype`, or `constructor`) fail closed. A non-empty
`extensions` array, including ordered entries, `required`, and `params`, is part
of both the signature payload canonicalization and complete canonical-document
hash. Only an explicitly empty protocol-default array is stripped. Existing
records do not gain extension evidence by projection: they must be re-admitted
and re-reviewed under the expanded parser before P4-5 route policy can refer to
them.

##### Host authorization, approval, and credential boundary

- The remote-routing boot and settings gate is independent from the existing
  local API and ph3 loopback gates, defaults OFF, and is captured as an immutable
  boot snapshot. A disabled gate performs no Agent Hub call, credential lookup,
  DNS lookup, or remote socket creation. Enabling it never widens or publishes
  the ph3 `127.0.0.1` listener.
- Every new initial `SendMessage`, continuation `SendMessage`, or live
  `CancelTask`, including one that selects a different in-binding
  credential revision, follows
  one strict order: (1) the gate, D8 depth, explicit target/interface identity,
  and authoritative project/profile/origin/task ownership pass host
  authorization; (2) a visible foreground `agent-action` approval names that
  exact immutable lineage tuple and `intendedCredentialRevisionId`; (3) durable
  preparation commits the prepared metadata-journal intent for every mutation;
  for an initial Send only, the exact serialized body is first placed in the
  OS-bound encrypted payload store and atomically bound by its opaque pointer,
  while continuation and Cancel preparation stores bounded metadata plus the
  semantic hash only and never stores a raw/encrypted body or payload pointer;
  (4) the OS-safe local resolver
  prepares the exact `intendedCredentialRevisionId` as one short-lived operation-
  bound secret handle; (5) the host performs the final authenticated no-store
  route resolve as the last control-plane gate; (6) the resolved target/interface
  and immutable lineage must byte-match the approved identity, and the resolved
  `credentialRevisionId` must equal prepared `intendedCredentialRevisionId`, after
  which the host CAS-attaches the complete snapshot ID, revision tuple, expiry,
  extension-specification digest, and resolve timestamp to the prepared journal;
  and (7)
  the data-plane socket starts immediately. The bearer never enters the journal
  and the prepared handle is destroyed on every pre-socket failure. If the final
  resolve changes identity or lineage, the operation stops before snapshot
  attachment or data-plane I/O and requires a new foreground approval. For an
  initial Send only, failed-preparation and orphan cleanup applies to its staged
  or bound encrypted payload; continuation and Cancel have no body payload or
  payload-pointer cleanup path. A failed prepared intent can never be sent.
  Headless or
  background approval, remembered allow-always state, bearer possession, or
  earlier route evidence cannot replace this sequence. Denial or approval
  failure creates no payload, mutation intent, secret preparation, final resolve,
  or data-plane I/O.
- Route evidence is never an authorization cache. The final resolve immediately
  before every `SendMessage`, `GetTask`, continuation, or `CancelTask` makes
  Agent Hub re-evaluate the complete conjunctive eligibility predicate and
  return a fresh exact snapshot with `Cache-Control: no-store`; the host neither
  persists it as a reusable grant nor reuses it for a later operation. A cached,
  expired, incomplete, unavailable, or identity-mismatched result fails closed
  before snapshot attachment or data-plane I/O and destroys the prepared local
  secret handle.
- Reads used to reconcile an already-approved operation (`GetTask`) and an exact
  initial-Send replay do not create a successor mutation and do not show another
  foreground prompt. Each attempt still performs fresh local owner/task/target/
  interface authorization, commits a bounded reconciliation/replay-attempt
  journal record, prepares the exact OS-safe local credential handle, performs a
  final no-store resolve as the last gate, CAS-attaches the fresh matching
  snapshot metadata, and starts the socket immediately. Exact replay additionally
  decrypts and reuses the already-approved immutable request bytes and Message ID;
  it cannot reconstruct or alter them. These are the only prompt-free carve-outs:
  a fresh resolve may change only `credentialRevisionId` within the same exact
  `credentialBindingId` and `callerGenerationId`; `targetAgentId`, exact
  `interfaceUrl`, `agentCardDigestSha256`, `trustKeyId`, route-policy version and
  digest, and `extensionSpecDigestSha256` remain fixed. Neither operation can discover or
  enumerate unrelated remote Tasks.
- Agent Hub returns only the credential binding/revision ID plus bounded
  non-secret version, provider, and `external_version` metadata. It never returns
  P4-3's raw `secret_reference`, its server-internal keyed fingerprint, or any
  value derived from the reference or secret. After host authorization, approval,
  and durable preparation, an injected local resolver prepares an OS-safe,
  out-of-band provisioned secret by the intended exact binding/revision ID and
  verifies only the revision mapping. It cannot pre-prove the bearer bytes; the
  remote server remains the authentication authority. A wrong bearer produces
  one fixed authentication failure with zero credential or route retry. The
  resolver does not call Agent Hub or dereference a Hub value. The prepared secret
  is held only for the bounded operation, remains unusable until the final
  no-store snapshot byte-matches the approved binding/revision lineage, and is
  sent solely as
  `Authorization: Bearer <value>` to the
  pinned remote interface, and is never copied into Hub responses, persistence,
  logs, errors, metrics, traces, crash reports, Task journals, or audit. Missing,
  mismatched, rotated, or revoked local resolution fails closed with zero remote
  I/O.
- The first slice accepts A2A v1.0 over public HTTPS, `JSON-RPC`, and HTTP Bearer
  authentication only. It rejects HTTP, other bindings, embedded URL
  credentials, cookies, API-key query parameters, and mTLS-only profiles. The
  client selects an exact interface-advertised `1.0` protocol version and sends
  `A2A-Version: 1.0` on every operation. That version header never activates an
  extension. Only an initial Send and its already-approved exact replay negotiate
  and send the
  canonical LVIS exact-send-replay extension
  `https://lvis.ai/a2a/extensions/exact-send-replay/v1`; continuation, `GetTask`,
  and `CancelTask` omit its activation header and metadata. The Agent Card entry
  uses `required: false`; LVIS route policy, not the A2A `required` flag, mandates
  its exact presence, parameters, served-specification digest, and Card digest
  for an eligible initial Send. If that route-policy-mandated contract is absent
  or malformed, the route is ineligible. Any additional
  extension marked `required: true` is unsupported and fails closed; unrelated
  optional extensions are ignored and are never negotiated, echoed, or
  executed. Patch versions never create a separate compatibility lane.
  Unsupported versions, bindings, authentication, or required extension
  contracts fail before credential resolution.

This profile follows the official A2A v1.0 rule that version negotiation is per
`AgentInterface`, that clients send the `A2A-Version` header, and that credentials
are obtained out of band rather than embedded in an Agent Card.

##### Public-network and transport invariants

- P4-5 does not weaken the P4-3 public-network boundary. Target and interface
  URLs use canonical public HTTPS with effective port 443; IP literals,
  loopback, private, link-local, carrier-grade NAT, multicast, documentation,
  benchmark, reserved, and otherwise non-global addresses are rejected. There
  is no LAN mode, insecure-development override, proxy fallback, redirect
  following, certificate bypass, alternate DNS path, or user-supplied Host/SNI.
- Route-snapshot retrieval and data-plane invocation have independent bounded
  host-owned deadlines, header/body limits, redirect limit zero, identity
  encoding, fresh DNS validation, fresh non-reused sockets, canonical SNI/Host,
  platform trust roots, and minimum TLS 1.2. Configuration delivered by the
  wire cannot increase a bound. Each implementation PR must name the constants
  and prove their exact boundaries before merge.
- Advertised-interface health is separate from P4-3 Agent Card/JWKS metadata-
  endpoint health. The snapshot references one current, versioned interface-
  health observation produced without a Task payload or credential disclosure.
  Health proves only the declared interface's bounded DNS/TLS/HTTP reachability;
  it neither changes trust, proves the bearer remains valid, nor proves replay
  semantics or extension conformance. Exact-send-replay conformance is separate
  pinned-head wire-vector evidence. The direct client still performs TLS,
  snapshot, authorization, and authentication checks on every operation.
- A revocation committed before the no-store resolve completes blocks the
  operation. The only unavoidable cross-plane gap is a revocation that commits
  after the resolve decision and before the already-authorized data-plane socket
  starts. That resolve-commit-to-socket race receives one fixed redacted audit
  outcome when observed; it never permits cached authorization, stale-secret
  retry, route substitution, or a fabricated remote Task result.

##### Durable Task transaction and idempotency

- The metadata journal is an explicit two-stage transaction. Before local secret
  preparation or the final Hub resolve, stage `prepared` durably contains only:
  host operation/attempt IDs; DLP-clean owner and operation kind; A2A method; the
  exact immutable lineage tuple (`targetAgentId`, canonical exact `interfaceUrl`,
  `agentCardDigestSha256`, `trustKeyId`, `credentialBindingId`,
  `callerGenerationId`, `routePolicyVersion`, `routePolicyDigestSha256`, and
  `extensionSpecDigestSha256`); D8 depth; semantic-request hash; for an initial
  Send only, the ciphertext hash plus opaque encrypted-payload record ID, size,
  and expiry; host-minted Message ID; any already-known Task/context IDs;
  approval decision ID/time for a mutation; created/attempt deadlines; mandatory
  bounded `intendedCredentialRevisionId` on every attempt; and bounded optional
  `predecessorCredentialRevisionId` only when a prior durable attempt exists.
  For a new mutation, `intendedCredentialRevisionId` is the exact revision named
  by foreground approval. For prompt-free `GetTask` or an already-approved exact
  initial-Send replay, it is the exact fresh locally authorized revision intended
  for that attempt. Neither revision field grants route or credential authority;
  both are authoritative intent constraints. Final resolve and CAS cannot
  substitute `intendedCredentialRevisionId`, and a present predecessor must match
  the prior durable attempt. `snapshotId`, resolved
  credential revision, resolve timestamp, and
  snapshot issue/expiry times are absent, not null placeholders. The immutable
  extension-specification digest is prepared lineage, not resolved authorization.
  Task text, Parts, artifacts, bearer, raw credential reference,
  `secret_reference`, and raw response are never stored in this journal.
  Persistence failure means zero secret lookup, Hub resolve, and data-plane I/O.
- Only after secret preparation and a successful final no-store Hub resolve may a
  compare-and-swap change that exact attempt to stage `resolved`. The CAS adds the
  snapshot ID, resolved `credentialRevisionId`, resolve timestamp, and snapshot
  issue/expiry times. It also re-proves the complete immutable lineage tuple from
  the final resolve. Every immutable value must byte-match stage `prepared`, and
  both the final no-store Hub resolve and winning `resolved` CAS must match the
  mandatory exact `intendedCredentialRevisionId`. When present,
  `predecessorCredentialRevisionId` must equal the prior durable attempt;
  inference from "active" or "same binding" is insufficient. A missing or
  mismatched field or unauthorized revision zeroizes the prepared secret, deletes
  any unbound initial-Send staged payload, durably terminalizes the attempt as
  `NOT_SENT`, and performs zero socket I/O. A losing CAS also zeroizes its secret
  and opens no socket; an exact same-intended-revision duplicate may join the
  winner, while a differing intended revision takes the deterministic conflict
  path below. The socket may start only from the winning `resolved` revision and
  does so immediately; the snapshot is never a reusable grant.
- Credential intent is independently fenced even though attempt revision is
  excluded from semantic hash and encryption AAD. If foreground approval and
  stage `prepared` name revision A but final Hub resolve returns active
  same-binding revision B, B is not an acceptable substitute: the A attempt takes
  the exact mismatch `NOT_SENT` path above. Concurrent attempts with the same
  operation ID and byte-for-byte body but different
  `intendedCredentialRevisionId` values are conflicting, not identical. The
  operation fence permits at most the attempt whose intended ID exactly matches
  final resolve to win `resolved`; every other candidate receives one
  deterministic `INTENDED_CREDENTIAL_REVISION_CONFLICT`/`NOT_SENT`, and no case
  opens a duplicate socket.
- Initial-Send recovery bytes live in a separate host-only encrypted operation-
  payload store, never in the metadata journal. The journal carries only an
  opaque payload-record ID, ciphertext hash, and semantic hash. Before first
  data-plane I/O, the byte-for-byte serialized HTTP body of the initial
  `SendMessage` is encrypted with an OS-bound host key. Encryption AAD is the
  versioned canonical encoding of the authenticated owner ID, operation ID,
  Message ID, exact body SHA-256, and the exact immutable lineage tuple
  (`targetAgentId`, canonical exact `interfaceUrl`, `agentCardDigestSha256`,
  `trustKeyId`, `credentialBindingId`, `callerGenerationId`,
  `routePolicyVersion`, `routePolicyDigestSha256`, and
  `extensionSpecDigestSha256`). Attempt `credentialRevisionId`, mandatory
  `intendedCredentialRevisionId`, optional `predecessorCredentialRevisionId`,
  snapshot ID, and snapshot times are excluded from AAD and are journaled
  separately. The record
  contains no bearer or
  transport header, has a fixed maximum size and retention TTL, and is never
  returned to Agent Hub or copied into audit, logs, metrics, traces, errors, or
  crash reports. A continuation `SendMessage` and `CancelTask` retain only bounded
  journal metadata plus the semantic hash; they never persist a raw HTTP body or
  encrypted replay payload because this extension cannot replay them.
- Initial-Send payload/journal creation is a fail-closed two-phase storage
  transaction; it does not apply to continuation or Cancel preparation. The
  host first writes ciphertext as non-sendable `staged` with its operation ID,
  hash, size, and bounded orphan deadline. One durable transaction then creates
  stage `prepared` referencing those exact fields and changes the payload to
  `bound`; no socket path accepts `staged`. If that transaction fails, the staged
  payload is deleted immediately. Restart deletes any unbound staged record whose
  orphan deadline elapsed, and quarantines a prepared record whose bound payload
  is missing or mismatched, always with zero secret lookup, Hub resolve, or socket
  I/O. Thus neither a ciphertext-only orphan nor a journal-only reference can be
  replayed. Only a bound record may proceed, in this order: local secret
  preparation; final no-store Hub resolve; CAS to stage `resolved`; then the
  socket may start.
- The host deletes bound initial-Send ciphertext at the earlier of client-observed
  durable settlement or its bounded recovery TTL. Settlement is the client-journal
  commit after validating the complete JSON-RPC response, exact request ID,
  `SendMessageResponse` oneof wrapper or terminal error, and required extension
  echo. A response that may
  have been lost before that durable commit is not settled, so its ciphertext is
  retained until successful replay/reconciliation or TTL. TTL expiry deletes
  unresolved ciphertext after durably recording the fixed manual-reconciliation
  outcome.
  Encryption failure means zero initial data-plane I/O. Missing, expired,
  hash-mismatched, or undecryptable recovery ciphertext settles locally as
  `unknown-manual-reconciliation-required` with zero resend and no fabricated
  remote state.
- The semantic hash covers the canonical method, exact immutable lineage tuple,
  Task/context/Message identities, configuration, and the canonical
  DLP-processed payload. It excludes attempt `credentialRevisionId`, mandatory
  `intendedCredentialRevisionId`, and optional
  `predecessorCredentialRevisionId`; those revisions are separate journal fields
  and cannot change the approved semantic intent.
  An exact replay joins or returns the existing operation. Reuse of an operation
  or Message ID with any semantic difference is rejected before approval,
  credential lookup, or network I/O. Concurrent identical callers have one
  owner; concurrent distinct mutations against one Task serialize and revalidate.
- Restart interprets the two stages conservatively. A valid `prepared` attempt
  with no snapshot fields proves that no socket could have started; it discards
  any lost in-memory secret handle and may resume the already-approved operation
  without another prompt only after fresh local authorization, secret preparation,
  final no-store resolve, and a new winning stage-`resolved` CAS. A `resolved`,
  `in-flight`, or partially settled attempt is outcome-ambiguous: it never reuses
  the snapshot. A known Task ID permits only prompt-free exact-immutable-lineage
  `GetTask` with the credential-revision-only carve-out above;
  a lost initial-Send response permits only the immutable exact-byte replay below;
  other mutations are never resent. Invalid field combinations, including any
  snapshot field at stage `prepared` or missing required field at stage `resolved`,
  are quarantined with zero outbound I/O.
- A first-slice route is eligible only when its Agent Card has the exact LVIS
  exact-send-replay extension entry with `required: false` and exact parameters,
  and route policy explicitly mandates that identifier
  `https://lvis.ai/a2a/extensions/exact-send-replay/v1` and the
  route policy pins the served specification digest plus a passing pinned-head
  wire-conformance artifact. Advertised-interface health proves only declaration
  reachability and never supplies this evidence. The server must durably map the
  same authenticated caller, initial `SendMessage` Message ID, byte-for-byte
  identical serialized HTTP body, and semantic intent hash to one complete A2A
  v1 `SendMessageResponse` oneof wrapper: exactly `{ message: Message }` or
  `{ task: Task }`. The JSON-RPC `result` contains that wrapper; a raw Message,
  raw Task, both branches, or unwrapped union is invalid. An exact retry returns
  the same wrapper branch and durable identity without executing again, while the
  same Message ID with a different body or intent hash fails with one fixed
  conflict. The client negotiates and sends this extension only on the initial
  Send and an exact replay of that same initial Send. Continuation `SendMessage`,
  `GetTask`, and `CancelTask` MUST omit its header and metadata, and their server
  responses MUST omit its echo. An absent or malformed route-policy-mandated
  contract makes the route ineligible; any additional `required: true`
  extension is unsupported and fails closed, while unrelated optional
  extensions are ignored without negotiation, echo, or execution. This is an
  LVIS route requirement, not a claim that A2A v1.0 universally guarantees Send
  idempotency.
- The first `SendMessage` is non-streaming and accepts the protocol-defined
  `SendMessageResponse` oneof wrapper. Its `message` branch is a successful terminal result
  for that operation and has no fabricated Task ID. A Task result records the
  remote Task/context IDs before exposing success. Continuations reuse the exact
  Task, context, complete immutable lineage tuple, and a new host-minted Message
  ID; any intended credential-revision change is separately approved.
  `INPUT_REQUIRED` preserves the ph3 typed `reason` and resume semantics.
  `AUTH_REQUIRED` remains a confirmed remote interrupted Task state; it is not
  converted into a fabricated local failure or terminal remote state, and the
  host never solicits or transmits credentials through a Task Message. Unless
  authorization details were negotiated out of band or through another accepted
  extension, `AUTH_REQUIRED` MUST include a `TaskStatus.message` explaining the
  required authorization. The current operation settles with one fixed local
  auth-required outcome. After a different in-binding credential revision is
  provisioned out of band, the server MAY continue processing without a follow-up
  Message. The host
  therefore reconciles with prompt-free `GetTask` attempts using the fresh local/
  journal/secret/final-resolve order. If a new continuation Message is actually
  required, it is a successor mutation and requires new explicit foreground
  approval while preserving the same Task/context and complete immutable lineage
  tuple. No
  credential or route retry occurs inside the settled operation.
- A confirmed A2A Task state advances monotonically and terminal states never
  regress. Local transport state (`prepared`, `in-flight`, `outcome-unknown`,
  `reconciling`, or `settled`) is stored separately and never fabricated as a
  remote Task state. A timeout, reset, partition, app stop, or audit failure
  cannot claim that a remote Task failed or was canceled without remote evidence.
- Once a remote Task ID is durable, an ambiguous send/resume/cancel outcome is
  reconciled only with bounded `GetTask` calls against the exact immutable
  lineage tuple. A fresh attempt may change only `credentialRevisionId` inside
  the same `credentialBindingId`/`callerGenerationId`. Reconciliation never
  resends that mutation, creates a new Message ID, or changes route.
- If the initial `SendMessage` body was written but its response was lost before
  a remote Task ID became durable, `GetTask` is impossible. The host may perform
  a bounded replay only after a fresh no-store route resolve confirms the exact
  immutable lineage tuple; only `credentialRevisionId` may differ inside the
  same binding/generation. The attempt
  must decrypt and reuse the stored exact serialized body, Message ID, and
  semantic intent hash, including after host restart. It never reconstructs the
  request, changes an accepted field, or retries under an assumed spec-wide
  deduplication rule. Missing/expired/invalid ciphertext, encryption/decryption
  failure, or an extension that is unavailable, disappears, conflicts, or
  cannot return an unambiguous original result makes the local recovery outcome
  terminal
  `unknown-manual-reconciliation-required`. No further automatic resend occurs
  and no remote A2A terminal state is fabricated.

##### Cancellation, revocation, partition, and restart recovery

- `CancelTask` is permitted only for the exact owned, nonterminal remote Task.
  The host persists intent before the request, applies the same foreground
  approval and current-route checks, and accepts only the updated `Task` returned
  by the server. The host's exact operation replay is idempotent: it joins or
  returns the stored result and never emits a second Cancel request. A missing,
  inaccessible, expired, completed-and-purged Task is `TaskNotFoundError`; a
  still-present Task that is already terminal is `TaskNotCancelableError`.
  `CANCELED` is confirmed only from the updated remote result or later `GetTask`.
  Losing the race to another terminal state preserves the remote terminal winner.
- `GetTask` is exact-ID and owner scoped. A nonexistent, inaccessible, expired,
  or purged Task is `TaskNotFoundError`, without revealing which condition
  applied. `historyLength` follows A2A v1.0 exactly: omitted means the client
  imposes no limit, zero requests no history Messages, and a positive value is an
  upper bound on the most recent Messages which the server may lower. P4-5 sends
  zero for routine reconciliation and rejects negative, non-integer, or host-
  configured values above 64 before control-plane or data-plane I/O.
- Resume from confirmed `INPUT_REQUIRED` revalidates the exact context and route
  lineage after approval, commits its Message intent before I/O, and never
  widens the original host-owned tool/project scope. A confirmed remote
  `AUTH_REQUIRED` is a distinct interrupted state: the settled operation accepts
  no Task-carried credential or automatic retry. After an administrator or user
  provisions a different in-binding credential revision out of band, the server
  may continue the same Task automatically. Prompt-free `GetTask` observes that
  transition only
  through an active revision of the same exact `credentialBindingId` and
  `callerGenerationId`, with every other immutable-lineage field unchanged. The
  attempt journal records mandatory exact `intendedCredentialRevisionId` and,
  when a prior durable attempt exists, optional exact
  `predecessorCredentialRevisionId` before final resolve. Neither field grants
  route authority, but both are authoritative intent constraints: final resolve
  and resolved CAS must prove the intended ID against the same immutable lineage,
  and a present predecessor must match the prior durable attempt. A
  client continuation Message is permitted only when the server still requires
  one, after new explicit foreground approval and the ordered durable-preparation,
  local-secret, final-no-store-resolve sequence proves the exact immutable
  lineage tuple and explicitly approved credential revision.
- Timeout has three independent meanings: one bounded HTTP attempt deadline,
  one bounded reconciliation window, and the existing ph3 unanswered-input Task
  TTL. None is silently extended by Agent Hub or the remote server. Expiring the
  reconciliation window retains an explicit local `outcome-unknown`; expiring
  the input TTL requests cancellation and still requires remote confirmation.
- Credential/key/target/policy revocation or unhealthy/stale interface evidence
  blocks every attempt before socket use and never authorizes a stale credential
  merely to retrieve or cancel a Task. An already approved operation remains
  durable and its remote Task remains unresolved. After an administrator restores
  eligibility, prompt-free `GetTask` reconciliation and an immutable exact-byte
  initial-Send replay may resume that same operation with a changed credential
  revision only when it is active in the same exact `credentialBindingId` and
  `callerGenerationId`, every other immutable-lineage field is unchanged, and
  fresh local authorization, secret preparation, final no-store resolve, and
  snapshot CAS succeed. The attempt journal records mandatory exact
  `intendedCredentialRevisionId` plus optional
  `predecessorCredentialRevisionId` when a prior attempt exists; the final resolve
  and resolved CAS prove the intended ID before socket I/O. They never
  reuse prior route evidence or substitute caller identity, binding, target,
  interface, Card digest, key ID, route policy, or extension digest. No new
  foreground approval is required because neither creates a successor mutation.
  Every new initial `SendMessage`, continuation `SendMessage`, or live
  `CancelTask` is a new mutation
  and still requires the visible foreground approval sequence, even if it follows
  revocation recovery or uses a different eligible in-binding credential
  revision.
- On restart, the host loads only structurally valid prepared/in-flight/unknown
  records, revalidates ownership and the current exact route state, and resumes
  bounded reconciliation where a remote Task ID exists. Invalid, duplicate,
  cross-owner, expired, or conflicting records are quarantined and audited with
  zero outbound I/O. Shutdown aborts live requests but does not delete durable
  unknown outcomes.

##### Audit, D8, and exclusions

- Control-plane snapshot issuance and host data-plane execution have separate
  append-only audit streams joined by the host operation ID and snapshot ID.
  Host audit records fixed operation/state/outcome codes and opaque keyed tokens
  for target, interface, task, and credential revision. It never records Task
  content, remote status text, artifacts, raw URLs, raw IDs, raw credential
  references, secrets, headers, bodies, DNS answers, or raw OS/TLS errors.
  Replay emits no duplicate execution audit; recovery records the recovery actor
  and predecessor operation without rewriting earlier evidence.
- D8 remains depth-1. P4-5 adds a remote route, not a nested-creation loophole:
  a depth-1 local child cannot create a remote Task, the remote route is absent
  from its scoped tool surface, and the hard depth check runs before Agent Hub,
  approval, secret, or network effects. Any decision to allow deeper delegation
  is a separate post-routing policy change with its own threat model, user
  approval contract, limits, and regression review.
- Plugin/HostApi integration, Marketplace behavior, meeting, local-indexer,
  plugin-SDK alignment, work-assistant registration, private/LAN routing,
  streaming, push notification, non-Bearer authentication, and Agent Hub Task
  relay/storage are excluded. They are neither prerequisites nor fallback paths.

##### P4-5 normative completion matrix

| Gate | Required evidence |
| --- | --- |
| Ownership | generic host-owned remote A2A client and control-plane interfaces; no plugin, HostApi, Marketplace, work-assistant, meeting, local-indexer, or plugin-SDK dependency |
| Plane separation | Agent Hub issues only bounded no-store route snapshots; packet capture plus Hub response/storage/log/audit assertions prove every Task payload, response, Task/context ID, artifact, `secret_reference`, raw reference derivative, and secret stays outside Hub and every Task method travels only between the client host and exact remote A2A server |
| Opt-in | separate immutable boot gate defaults OFF; disabled mode performs zero control-plane, secret, DNS, socket, listener, or Task-journal effect and does not change ph3 loopback behavior |
| Eligibility | one immutable unambiguous no-store snapshot proves active target + active exact trust-key revision + active exact credential binding/revision ID and bounded version/provider/external_version metadata + current advertised-interface declaration/reachability health + explicit host/operation route policy + separately pinned exact-send-replay specification digest and pinned-head wire-conformance artifact; health is never replay-conformance evidence, trusted or healthy alone is never enough, and every Send/Get/continue/Cancel resolves again as the last control-plane gate before data-plane I/O |
| Host authorization | new-mutation order is gate/depth/explicit target+interface host authorization -> foreground approval -> prepared journal for every mutation, with an encrypted exact-body record+pointer only for initial Send and metadata+semantic hash only for continuation/Cancel -> OS-safe local secret preparation -> final no-store resolve -> exact immutable-lineage and intended-revision proof plus CAS snapshot-metadata attachment -> immediate socket; identity drift requires reapproval and zero data-plane I/O; failed-preparation/orphan body cleanup is initial-Send-only; GetTask and exact replay omit only the prompt and still perform fresh local authorization, attempt journal, local secret preparation, final resolve, and snapshot attachment before the socket |
| Protocol | A2A v1.0, public HTTPS/443, JSON-RPC, non-streaming, Bearer only; exact supported interface and per-interface `1.0` negotiation; `A2A-Version: 1.0` on every request without activating any extension; Agent Card declares the exact profile with `required: false`, while LVIS route policy mandates its exact presence/params/Card/spec digests for eligible initial Send; `https://lvis.ai/a2a/extensions/exact-send-replay/v1` activation is sent only for an initial Send and exact replay of it, never continuation/Get/Cancel; every activated success and `-32090..-32094` error echoes it, only `-32092` carries Retry-After, and all errors are full JSON-RPC envelopes with exact request ID; absent/malformed route-policy-mandated contract is ineligible; additional `required: true` extensions fail closed while unrelated optional extensions are ignored without negotiation/echo/execution |
| Credential | snapshot exposes only exact binding/revision ID plus bounded version/provider/external_version metadata; P4-3's internal keyed fingerprint is never returned; an out-of-band provisioned OS-safe local resolver maps the exact revision per operation but cannot pre-prove bearer bytes; no `secret_reference`, secret, or derivative in Hub response, journal, logs, audit, traces, metrics, errors, or crash reports; wrong bearer yields one fixed auth failure with zero retry/fallback and rotation/revocation mismatch is zero data-plane I/O |
| Network | P4-3 public-address, DNS-rebinding, fresh-socket, no-proxy, redirect-zero, TLS/hostname, size, encoding, and deadline invariants apply independently to control and data planes; no private/LAN/development bypass |
| Route pinning | the immutable lineage tuple is exact `targetAgentId` + canonical exact `interfaceUrl` + Agent Card digest + key ID + `credentialBindingId` + `callerGenerationId` + route-policy version/digest + extension-spec digest; only prompt-free GetTask and already-approved exact initial-Send replay may change `credentialRevisionId` inside the same binding/generation, while every new mutation requires approval; no automatic alternate interface, binding, target, local-agent fallback, proxy relay, or route migration |
| Durable intent | every attempt commits prepared metadata with mandatory exact `intendedCredentialRevisionId` and prior-attempt-only optional `predecessorCredentialRevisionId`; new mutations take the intended ID from foreground approval, while prompt-free GetTask/exact replay use a fresh locally authorized intended ID; neither field grants route authority, but both are authoritative intent constraints: final resolve and stage-`resolved` CAS must match the intended ID, and a present predecessor must match the prior durable attempt; mismatch zeroizes the secret, deletes any unbound initial staged payload, terminalizes `NOT_SENT`, and opens no socket; only initial Send ciphertext enters non-sendable `staged` and is atomically bound by opaque pointer, while continuation/Cancel persist metadata+semantic hash only; encryption AAD and semantic intent bind immutable lineage but exclude attempt revision fields; settlement or TTL deletes initial ciphertext, while a lost response retains it until replay/reconciliation or TTL |
| Idempotency and concurrency | identical local replay joins one owner and produces no duplicate mutation/audit; distinct concurrent Task mutations serialize and revalidate; post-write initial Send recovery replays only the exact immutable lineage tuple (with credential-revision-only same-binding/generation carve-out) + byte-for-byte identical serialized HTTP body + same Message ID + same intent hash and returns the same complete `SendMessageResponse` oneof wrapper under JSON-RPC `result`; at seven days one CAS terminalizes live/in-progress fences as RETENTION_EXPIRED, revokes owner tokens, writes tombstone, and suppresses late commits; fixed in-progress, outcome-unknown, capacity, conflict, and retention envelopes/client mappings |
| State | a first non-streaming Send accepts either a terminal direct Message or a Task without inventing a Task ID; confirmed remote Task state is monotonic and separate from local delivery state; INPUT_REQUIRED resume preserves typed reason; remote AUTH_REQUIRED remains interrupted, MUST carry an explanatory TaskStatus.message unless details were negotiated out of band or through an accepted extension, settles the operation with a fixed local auth-required outcome, solicits no Task-carried credential, permits server auto-continuation after out-of-band provisioning observed through prompt-free GetTask, and requires new approval only if a successor continuation Message is sent on the same Task/context/immutable-lineage tuple; transport failure never fabricates remote FAILED/CANCELED |
| Recovery | known Task ID reconciles ambiguity only through bounded exact-immutable-lineage `GetTask` with the credential-revision-only same-binding/generation carve-out; lost initial response without Task ID, including after host restart, decrypts and reuses only the exact bound serialized bytes under verified exact-send replay and the same carve-out; missing/expired/hash-mismatched/undecryptable ciphertext or unavailable/conflicting extension terminates locally as `unknown-manual-reconciliation-required` with zero resend/fabricated remote state; restart, partition, late response, terminal race, retention deletion, and corrupted/duplicate record tests prove fencing and zero route substitution |
| Cancel/Get/resume/TTL | exact-owner nonterminal cancel and confirmed INPUT_REQUIRED resume persist intent, reauthorize, and preserve terminal winner; exact local Cancel replay is idempotent with no second request, successful Cancel returns updated Task, inaccessible/purged is TaskNotFoundError, and present terminal is TaskNotCancelableError; GetTask preserves TaskNotFound nondisclosure and exact bounded historyLength semantics; AUTH_REQUIRED tests prove required explanatory status unless OOB-negotiated, no Task credential solicitation/fabricated failure/retry, server auto-continuation after OOB provisioning observed by prompt-free GetTask, and new approval only for an actual successor Message; HTTP, reconciliation, and unanswered-input deadlines are distinct, bounded, and tested |
| Revocation | target/key/credential/policy/health loss is detected by per-attempt no-store resolve and blocks data-plane I/O while retaining unresolved Tasks; stale credentials are never used for cleanup; only the resolve-commit-to-socket race remains and receives one fixed audit outcome without retry/fallback; prompt-free exact replay/GetTask may change only credential revision in the same exact `credentialBindingId`/`callerGenerationId`, with every other immutable field fixed and mandatory `intendedCredentialRevisionId` proved by final resolve+CAS; optional `predecessorCredentialRevisionId` exists only for a prior durable attempt; every new Send/continue/Cancel mutation requires new explicit approval |
| Audit | append-only control/data-plane records correlate snapshot and operation without payload/secrets/raw refs/raw network evidence; replay is non-duplicating, the resolve-commit-to-socket race has one fixed redacted outcome, and recovery attribution never rewrites predecessor evidence |
| D8 | remote Task creation is unavailable at depth 1 and refuses before any control-plane, approval, credential, journal, or network side effect; current local spawnDepth and tool-blocklist regressions remain green |
| Packaged live | two independent hosts plus live Agent Hub: packaged LVIS client talks directly to a public-HTTPS remote A2A server and proves both `result.message` and `result.task` oneof branches, exact JSON-RPC IDs, all-five error envelopes/echoes with Retry-After only on `-32092`, `A2A-Version` on every operation but extension activation only initial Send/exact replay, `required: false` plus route-policy mandate, denied auth, AUTH_REQUIRED revision carve-out constrained to the same binding/generation and immutable lineage, approval/prepared revision A versus active same-binding Hub revision B yielding secret zeroize + `NOT_SENT` + no socket, concurrent same-operation/body attempts with different intended revisions yielding one exact-match winner and deterministic conflict/`NOT_SENT` losers with no duplicate socket, INPUT_REQUIRED resume, cancel, prompt-free GetTask, initial-only staged/bound orphan cleanup, continuation/Cancel metadata-only preparation, lost-response exact replay across restarts, live-owner expiry CAS/late-commit suppression, missing ciphertext manual reconciliation, malformed extension ineligibility, timeout/partition/revocation/no fallback, and zero Hub payload/secret/reference retention |
| Regression | ph1-ph3 in-process messaging, mailbox, approval, task-store/TTL, loopback bearer, official TCK, and external-SDK smoke remain green with the P4-5 gate both OFF and ON |

P4-5 evidence is four distinct blocking gates. A passing later gate never waives
an earlier failure, and combined ad-hoc logs are not an artifact:

| Gate | Required command contract | Required immutable artifact |
| --- | --- | --- |
| Deterministic local | lvis-app: `bun run check:a2a-p4-5-contract` then `bun run test:a2a-p4-5:deterministic` | `artifacts/a2a-p4-5/deterministic-local.json` with lvis-app full head SHA, contract/spec/checker SHA-256, constants, case counts, zero skips, and gate-OFF/ON results |
| SQLite + PostgreSQL | Agent Hub: `bun run test:a2a-p4-5:db:sqlite` and `bun run test:a2a-p4-5:db:postgres` against a named disposable PostgreSQL database | `artifacts/a2a-p4-5/database-parity.json` with Agent Hub full head SHA, migration/schema hashes, both database versions, per-engine case counts, zero skips, transaction/fence/replay parity, and clean teardown |
| Cross-repo pinned-head wire vectors | lvis-app: `bun run test:a2a-p4-5:wire -- --app-head <full-sha> --hub-head <full-sha> --server-head <full-sha> --tck-version <tag> --tck-commit <full-sha>` | `artifacts/a2a-p4-5/wire-conformance.json` plus raw signed result bundle; it pins every full repository head, the official `a2aproject/a2a-tck` release/tag and full commit, dependency lock hashes, A2A v1.0 URL, served extension-spec digest, Agent Card digest, vector count, zero skips, and bundle SHA-256 |
| Packaged live | lvis-app: `bun run test:a2a-p4-5:packaged-live -- --manifest artifacts/a2a-p4-5/live-input.json` | `artifacts/a2a-p4-5/packaged-live.json` plus signed packet-capture, Hub storage/log/audit absence report, packaged-app identity/signature, two-host identity, fault matrix, and SHA-256 manifest |

The three future runtime commands in lvis-app and the two Agent Hub database
commands MUST be added by the implementation PR that owns their behavior; a
contract-only PR MUST NOT install placeholder pass-through scripts. The checked-
in contract checker is executable now. No gate may use a mutable branch, `latest`
URL, abbreviated SHA, implicit TCK checkout, skipped PostgreSQL suite, loopback-
only packaged topology, or manually edited summary. The official protocol pin is
`https://a2a-protocol.org/v1.0.0/specification/`; the wire artifact must additionally
name the exact official TCK version and full commit actually executed.

The packaged-live gate must use two independent machines or network namespaces,
not two loopback processes. One runs the packaged LVIS A2A client, the other the
remote A2A v1.0 server, and both use a live Agent Hub control plane. The capture
must demonstrate that the client connects to the snapshot's remote interface,
not to Agent Hub for Task methods; Agent Hub database, application logs, audit,
and traces must remain free of Task payloads, remote responses, and secrets.
Failure scenarios must preserve one durable correlation chain and prove no
automatic alternate route or local-agent fallback. The live matrix also drops
an initial `SendMessage` response after the body reaches the server and proves
that the negotiated exact-send-replay extension executes it once and returns
the same complete `SendMessageResponse` oneof wrapper under JSON-RPC `result`
across both client and server restart from
the OS-bound encrypted payload record. Missing, expired, hash-mismatched, or
undecryptable ciphertext must instead produce the fixed manual-reconciliation
outcome with zero resend. Repeating the case
without verified extension support must produce
`unknown-manual-reconciliation-required` and zero automatic resend. Repeated
operations must also prove absent/malformed canonical-extension ineligibility,
additional-`required: true` rejection, unrelated-optional-extension ignore, and
Agent Hub route resolution is no-store. Revocation before resolve blocks the
socket and the only residual resolve-commit-to-socket race is recorded with its
fixed redacted audit outcome.

## Cross-host implementation review and follow-on constraints

A fourth review lane compared current CLI/Desktop hosts using primary sources. The detailed notes and contribution drafts live in [the upstream contribution candidates](../research/a2a-upstream-contribution-candidates.md).

- **Codex CLI/app-server** exposes host-native parent/child thread IDs, structured collaboration items, active-turn steering, and explicit history injection. This reinforces the split between a live steer and a durable idle delivery; it does not replace the ph1 mailbox commit/ACK transaction.
- **Gemini CLI** isolates each local subagent's tools and confirmation label, forbids recursive agent tools, queues background completions at an inter-turn boundary, and can consume remote A2A agents through Agent Cards. It is the preferred ph3 loopback interoperability smoke target, but the test must negotiate the supported protocol version rather than assume its documentation examples are v1.
- **goose CLI/Desktop** runs subagents as separate Agent/session instances with cancellation and structured tool notifications through a shared engine. This supports one lifecycle pipeline for foreground, background, CLI, and Desktop projections.
- **OpenHands CLI/GUI** demonstrates a typed event stream for agent/runtime/UI interaction. Its internal delegation events are useful UI precedent, not evidence of A2A conformance.

Resulting constraints:

1. Ph2 sends to an active recipient only at its safe inter-round boundary; interrupt/restart is a separate explicit operation.
2. Ph3 keeps the wire opt-in and loopback-only, runs the official TCK, and adds one local external-client smoke covering COMPLETED, INPUT_REQUIRED continuation, CANCELED, and rejected authentication.
3. Ph4 owns cross-machine trust, the Agent Hub Agent Card registry, and the later host↔Agent Hub remote route. Plugin work-assistant registration is excluded. None of those relaxes D8's depth-1 creation stop.

## References

Design inputs: A2A v1.0 spec + official SDK survey (2026-07-10 research, npm-registry-verified); transport/SDK-lane design review; INPUT_REQUIRED state-policy review (state inventory table with file:line evidence for `subagent-runner.ts`, `agent-spawn.ts`, `query-loop.ts`, `approval-gate.ts`, `tool-timeout-policy.ts`, `conversation-loop.ts`, `use-workflow-tools.ts`). All internal claims were verified against `main` at authoring time.

P4-3 security references: [A2A specification](https://a2a-protocol.org/latest/specification/), [Node.js HTTPS](https://nodejs.org/api/https.html), [JWS (RFC 7515)](https://www.rfc-editor.org/rfc/rfc7515.html), [JWK (RFC 7517)](https://www.rfc-editor.org/rfc/rfc7517.html), [JWT BCP algorithm-verification guidance (RFC 8725)](https://www.rfc-editor.org/rfc/rfc8725.html), [HTTP caching (RFC 9111)](https://www.rfc-editor.org/rfc/rfc9111.html), [TLS service identity (RFC 9525)](https://www.rfc-editor.org/rfc/rfc9525.html), [WHATWG URL](https://url.spec.whatwg.org/), [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), and [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).

P4-5 protocol references: the official [A2A v1.0.0 release](https://github.com/a2aproject/A2A/releases/tag/v1.0.0), immutable [A2A v1.0 specification](https://a2a-protocol.org/v1.0.0/specification/), [A2A extension guide](https://a2a-protocol.org/latest/topics/extensions/), [Agent Discovery guidance](https://a2a-protocol.org/latest/topics/agent-discovery/), [v1.0 interface changes](https://a2a-protocol.org/latest/whats-new-v1/), and the checked-in [LVIS exact-send-replay v1 profile](../protocols/lvis-a2a-exact-send-replay.md). Every wire-conformance artifact pins the official TCK release/tag, full commit, and dependency-lock hash used by the run; a mutable TCK branch is not evidence.
