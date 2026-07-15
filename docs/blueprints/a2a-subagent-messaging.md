# A2A Inter-Subagent Messaging — Blueprint

- Status: **Accepted; ph1-ph3 merged; ph4 P4-0 closed, P4-1 registry admission merged, and P4-2 durable Agent Card registry contract locked** (D1-D8 locked by the owner on 2026-07-11; ph4 boundary locked 2026-07-15)
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
  `JSONRPC` binding and a supported protocol version, and declares at least one
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
