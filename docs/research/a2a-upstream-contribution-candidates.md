# A2A upstream contribution candidates

- Checked: **2026-07-12 (Asia/Seoul)**
- Sources: official A2A Protocol, A2A TCK, and A2A JavaScript SDK repositories only
- Submission status: research draft; no upstream issue or pull request has been submitted

## Purpose and non-goals

This note separates reusable upstream improvements from behavior that belongs to a single host implementation. It records the smallest reproducible problem, a bounded proposal, and evidence that would demonstrate acceptance for each candidate.

Non-goals:

- Do not publish private implementation identifiers, logs, policy constants, UI details, or internal repository structure.
- Do not describe a host-specific execution budget as a protocol requirement.
- Do not claim protocol conformance from tests that bypass an A2A binding.
- Do not introduce a standard in-process transport identifier or durable mailbox contract without cross-implementation evidence.
- Do not open a new issue where the released specification or an existing upstream issue already covers the behavior.

Primary references:

- [A2A v1.0.0 specification](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md)
- [A2A v1.0.0 protocol definition](https://github.com/a2aproject/A2A/blob/v1.0.0/specification/a2a.proto)
- [A2A TCK](https://github.com/a2aproject/a2a-tck)
- [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js)

## Priority

| Priority | Candidate | Upstream fit | Recommended action |
| --- | --- | --- | --- |
| 1 | External `BaseTransportClient` factories in the TCK | High | Open a focused TCK issue, then a small PR if maintainers accept the registration mechanism |
| 2 | Generic `PAUSED` lifecycle case | Medium-high | Comment on existing lifecycle issues; do not open a duplicate or include host budget details |
| 3 | `INPUT_REQUIRED` and `AUTH_REQUIRED` TCK coverage | High after a real binding exists | Contribute to existing TCK issues after the wire phase can provide a deterministic SUT |
| 4 | JavaScript SDK in-process `TransportFactory` example | Medium-low | Ask maintainers whether a public-API-only documentation example is wanted |
| — | Internal approval waits and durable host mailboxes | Not an upstream gap | Do not open new issues |

## 1. TCK external `BaseTransportClient` factory

### Upstream fit

**High.** The TCK already defines a transport-independent [`BaseTransportClient`](https://github.com/a2aproject/a2a-tck/blob/main/tck/transport/base.py), and its compatibility tests operate through that interface. However, [`TransportManager`](https://github.com/a2aproject/a2a-tck/blob/main/tck/transport/manager.py) currently maps only `grpc`, `jsonrpc`, and `http_json` through a private fixed factory table and rejects every other transport name. The lifecycle suite therefore cannot be reused by a conforming custom binding without patching or forking the TCK. See the existing [task lifecycle tests](https://github.com/a2aproject/a2a-tck/blob/main/tests/compatibility/core_operations/test_task_lifecycle.py).

This should remain a black-box compatibility enhancement. A pure in-memory state-machine oracle would not, by itself, demonstrate A2A interoperability.

### Minimal reproduction

1. Implement every abstract operation required by `BaseTransportClient` for a custom A2A binding.
2. Attempt to select that client through the normal TCK runner and fixtures.
3. `TransportManager` rejects the custom transport because its name is not in the fixed `_TRANSPORT_FACTORIES` table.
4. The downstream implementation must fork the TCK or edit internal registration code to run the unchanged compatibility suite.

### Issue draft

**Title:** `[Feat]: Allow external BaseTransportClient factories in the TCK runner`

**Body:**

> The TCK's compatibility tests are written against `BaseTransportClient`, but `TransportManager` only constructs the three built-in clients from a private fixed map. A custom binding that implements the complete abstract client contract cannot run the same suite without modifying the TCK.
>
> Please expose a bounded registration mechanism for transport client factories, such as a Python entry point or an explicit runner-level registry. Existing built-in transports, CLI defaults, requirement IDs, and report formats should remain unchanged. This request does not ask the TCK to ship an in-process transport, and execution through a custom adapter must not be described as conformance unless that adapter represents a documented A2A binding.

### PR draft

**Title:** `feat(tck): support externally registered transport client factories`

Proposed change:

- Add a documented `name -> BaseTransportClient factory` registration seam.
- Load external factories only when explicitly requested.
- Preserve the built-in transport registry and existing CLI behavior.
- Reject duplicate names and malformed factories with actionable errors.
- Record the external transport name in the existing compatibility report.
- Add tests using a minimal fake factory; do not add a production in-process binding.

### Exclusions

- No host-specific transport, session type, mailbox, or message bus in the TCK.
- No SDK dependency in the TCK core.
- No new state-transition rules beyond released normative requirements.
- No claim that direct method calls are automatically a standard A2A binding.

### Acceptance evidence

- A separately defined factory can be selected without editing TCK source.
- The unchanged compatibility tests are collected and invoked for that client.
- The three built-in transports retain identical behavior and reports.
- Unknown names, duplicate registrations, and invalid client implementations fail closed.
- TCK documentation clearly distinguishes adapter reuse from protocol conformance.

## 2. Generic `PAUSED` case: comment on existing issues

### Upstream fit

**Medium-high as a generic lifecycle problem, but not as a host budget feature.** A2A v1.0 defines `TASK_STATE_INPUT_REQUIRED` as requiring additional user input to proceed. A policy or resource suspension can be resumable without additional task-domain input, making `WORKING`, `INPUT_REQUIRED`, and terminal states all imperfect projections. See the [`TaskState` comments in v1.0.0](https://github.com/a2aproject/A2A/blob/v1.0.0/specification/a2a.proto).

This area already has upstream history:

- [#1276: Add PauseTask and ResumeTask](https://github.com/a2aproject/A2A/issues/1276) proposed a `PAUSED` state and pause/resume operations. It was closed while v1 scope was being constrained, not because the generic use case was disproved.
- [#1992: Multi-turn interaction gaps](https://github.com/a2aproject/A2A/issues/1992) is the current lifecycle umbrella.
- [#1942: v1.1 backlog consolidation](https://github.com/a2aproject/A2A/issues/1942) tracks additive lifecycle work for possible v1.1 scope.

### Minimal reproduction

1. A task is actively `WORKING`.
2. The server reaches a safe policy or resource checkpoint and stops execution.
3. The task can continue later after an explicit resume or policy change; no additional task-domain answer is required.
4. Reporting `WORKING` falsely says processing is active, `INPUT_REQUIRED` falsely asks for additional user input, and a terminal state prevents continuation.

### Existing-issue comment draft

Post to #1276 or #1992 after maintainers confirm the preferred tracking location:

> A generic case still appears uncovered by the v1 task states: an agent may stop at a safe policy or resource checkpoint and remain resumable without requiring additional task-domain input. `WORKING` is inaccurate while execution is stopped, `INPUT_REQUIRED` implies the client must provide additional user input, and terminal states prevent continuation.
>
> Would the project consider revisiting `PAUSED` for the lifecycle work tracked for the next additive version? The useful scope would be state semantics and message/send, cancel, subscribe, and explicit resume behavior. Implementation-specific quota names, counters, and UI states should remain outside the core protocol. A structured reason could begin as a TaskStatus Message extension rather than expanding the core enum for every policy.

### Proposal

- Decide whether `PAUSED` belongs in #1992 or requires reopening/replacing #1276.
- Define whether pause is client-initiated, agent-initiated, or both.
- Specify allowed transitions and behavior of message/send, cancel, get, and subscribe.
- Evaluate whether explicit Pause/Resume operations are required.
- Represent detailed reasons through the existing extension mechanism until multiple implementations justify a standard reason vocabulary.

### Exclusions

- No product-specific budget name, round count, retry count, or resume handle.
- No requirement that an arbitrary user message means “resume.”
- No UI display state or local scheduler behavior.
- No assumption that all policy pauses have identical authorization semantics.

### Acceptance evidence

- Maintainers identify one canonical issue for the generic paused lifecycle case.
- The accepted design distinguishes “needs additional input” from “resumable without new task input.”
- Operations permitted in `PAUSED` are normative and testable.
- Detailed reasons remain extensible rather than becoming host-specific core enum values.

## 3. Contribute to TCK #95 and #96 after the wire phase

### Upstream fit

**High once a deterministic protocol-facing SUT exists.** The TCK already tracks missing interrupted-state coverage:

- [#95: Add tests for Tasks in AUTH_REQUIRED state](https://github.com/a2aproject/a2a-tck/issues/95)
- [#96: Add tests for Tasks in INPUT_REQUIRED state](https://github.com/a2aproject/a2a-tck/issues/96)

Both issues were open when checked. Local state-projection unit tests are useful implementation evidence, but they cannot replace compatibility tests against an A2A binding.

### Minimal reproduction

1. Run the TCK against a deterministic SUT capable of entering `TASK_STATE_INPUT_REQUIRED` and `TASK_STATE_AUTH_REQUIRED`.
2. Observe that the current suite does not exercise the state-specific client behavior described by the released specification.
3. A regression in blocking return, follow-up message handling, or out-of-band authorization continuation is therefore not detected.

### Proposal

After a real binding is available:

- Extend the TCK scenario SUT so a test message deterministically selects each interrupted state.
- For `INPUT_REQUIRED`, verify that a blocking request returns the interrupted Task and a follow-up message can provide the requested input.
- For `AUTH_REQUIRED`, verify the interrupted Task and the behavior permitted for client messages and out-of-band credential resolution.
- Run identical semantic scenarios across every supported binding.
- Assign requirement IDs and report results through the normal compatibility collector.

### Exclusions

- No direct import of a downstream state mapper.
- No in-process-only test submitted as protocol compatibility evidence.
- No assumptions about a particular approval UI or credential store.
- No conflation of `INPUT_REQUIRED` and `AUTH_REQUIRED` continuation behavior.

### Acceptance evidence

- Tests fail against intentionally non-conforming interrupted-state fixtures.
- Tests pass across all supported transports against the deterministic reference SUT.
- Blocking, streaming, and follow-up behavior matches released normative text.
- #95 and #96 can be closed by the accepted tests without downstream-specific fixtures.

## 4. Optional JavaScript SDK in-process `TransportFactory` documentation

### Upstream fit

**Medium-low and documentation-oriented.** The JavaScript SDK already exposes a [`Transport` and `TransportFactory` interface](https://github.com/a2aproject/a2a-js/blob/main/src/client/transports/transport.ts). [`ClientFactoryOptions`](https://github.com/a2aproject/a2a-js/blob/main/src/client/factory.ts) accepts custom factories and includes a custom transport example. No direct official issue requesting an in-process transport example was found during the checked issue search.

Because custom injection already exists, a standard transport or large runtime feature is not justified. A small public-API-only example may still help embedded hosts and SDK tests if maintainers want it.

### Minimal reproduction

1. An application owns both an A2A client and a compatible request dispatcher in one process.
2. It wants to test the full Message/Task contract without opening a loopback port.
3. The custom `TransportFactory` seam is available, but there is no canonical end-to-end example covering request, stream termination, cancellation, and error mapping.

### Optional issue or PR draft

**Title:** `docs: add an in-process custom TransportFactory example for embedded agents and tests`

Proposed example:

- Implement a test-only `TransportFactory` using only public SDK interfaces.
- Accept an explicitly supplied dispatcher rather than a process-global registry.
- Preserve Message, Task, stream event, cancellation, and protocol error boundaries.
- Demonstrate one unary message, one streaming task, and cancellation.
- State clearly that this is an embedded adapter example, not a newly standardized A2A transport.

### Exclusions

- No standard `inproc` transport name or Agent Card discovery convention.
- No implicit global address registry.
- No mailbox durability, delivery retry, or exactly-once guarantee.
- No dependency on private SDK implementation classes.
- No coupling to a particular agent framework.

### Acceptance evidence

- The example compiles and runs using exported SDK APIs only.
- Unary, streaming, cancellation, and error tests preserve the same public data shapes as wire transports.
- Documentation distinguishes an embedded adapter from a standard binding.
- Maintainers confirm that the example adds value beyond the existing custom factory example.

## 5. Items that should not open new issues

### 5.1 Internal approval or plugin-auth waits

Do **not** open a new issue. [A2A issue #1582](https://github.com/a2aproject/A2A/issues/1582) raised the distinction between `INPUT_REQUIRED` and `AUTH_REQUIRED`, and [PR #1597](https://github.com/a2aproject/A2A/pull/1597) merged expanded In-Task Authorization guidance.

The released specification says `TASK_STATE_AUTH_REQUIRED` is used when the agent delegates fulfillment of an authorization request to the A2A client. It also permits credentials to arrive out of band and allows processing to continue without a follow-up client message. See [In-Task Authorization in v1.0.0](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md#76-in-task-authorization).

An approval or credential wait resolved entirely inside the serving host does not delegate fulfillment to the A2A client. Keeping that internal wait out of `AUTH_REQUIRED` is therefore an implementation choice consistent with the current specification, not a missing protocol feature.

Acceptance evidence for “no issue”:

- The client is not asked to provide or arrange authorization.
- No A2A-visible continuation action is required from the client.
- If responsibility is later delegated to the client, the implementation transitions to `AUTH_REQUIRED` and supplies the required status message.

### 5.2 Push ACK and durable mailbox semantics

Do **not** open a new core issue from a host mailbox design. A2A v1.0 already specifies the wire-level baseline:

- an agent MUST attempt webhook delivery at least once;
- a receiver MUST return HTTP 2xx to acknowledge successful receipt;
- receivers SHOULD process idempotently because duplicates may occur;
- retry with backoff is recommended but not an unconditional guaranteed-delivery contract.

See [Push Notification objects and guarantees](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md#43-push-notification-objects) and [Push Notification security](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md#132-push-notification-security).

The open [push-notification semantics epic #1988](https://github.com/a2aproject/A2A/issues/1988) concerns secret redaction, token format, and initial snapshot behavior. It is not evidence of a missing private mailbox commit/ack contract.

A durable in-process mailbox may choose stronger semantics, such as retaining an entry until actual injection succeeds, but persistence transactions and queue rollback are host-internal concerns. They should not be proposed as protocol requirements without failures reproduced across independent wire implementations.
Ph1 implementation findings: a durable local record must be re-authorized against authoritative child ownership and canonical provenance at consumption time; semantic message identifiers need host-side idempotency; rejected-entry cleanup must commit before any valid guidance is exposed; and acknowledgment must wait until the receiving model has successfully consumed the guidance. Failed turns must roll back their temporary history copy without erasing durable provenance, while setup persistence and cancellation races must converge on one terminal state across status, event, and Message projections. These are host-internal security and transaction requirements, not evidence for a new A2A core issue.

Acceptance evidence for “no issue”:

- Wire receivers acknowledge successful receipt with 2xx and tolerate duplicates.
- Host persistence failure does not get mislabeled as a successful local delivery.
- Documentation distinguishes “at least one attempt” from guaranteed at-least-once delivery.
- Any future proposal begins with cross-implementation evidence rather than a private queue design.

## 6. External host-agent implementation review (CLI/Desktop)

This comparison is implementation evidence for the host roadmap, not a claim that non-A2A collaboration APIs are protocol-compatible. It was added as a fourth review lane alongside the local architecture, critic, and security reviews.

| Host | Primary implementation evidence | Reusable lesson for this blueprint |
| --- | --- | --- |
| OpenAI Codex CLI/app-server | [send_input addresses a spawned thread and can optionally interrupt it](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs); the [app-server API](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) exposes typed collaboration items, parent/child thread relationships, turn/steer for an active turn, and thread/inject_items for explicit history injection | Keep identity, delivery, and UI projection separate. An active-turn steer is not the same transaction as a durable idle mailbox. A host-owned thread/session identifier is the routing address; display names remain metadata. |
| Gemini CLI | The [local subagent executor](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/local-executor.ts) creates isolated tool registries, derives a subagent-labelled message bus for confirmation, removes agent tools to prevent recursive spawning, and queues background completions for the next inter-turn boundary. Gemini CLI also documents [remote A2A subagents](https://geminicli.com/docs/core/remote-agents/) discovered from an Agent Card with API-key, HTTP, cloud credential, or OAuth providers | The ph1 guidance boundary, receiver-owned approval label, and D8 creation-depth stop match a shipped host pattern. Ph3 must test Agent Card discovery, supported protocol version, authentication failure, streaming result reassembly, and interrupted-task continuation rather than assuming that an A2A library alone provides host interoperability. |
| goose CLI/Desktop | [run_subagent_task](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/agents/subagent_handler.rs) creates a separate Agent/session, propagates cancellation, can return a concise final result or full conversation text, and emits structured subagent tool-request notifications. The documented [GOOSE_MAX_BACKGROUND_TASKS](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/environment-variables.md) bounds concurrent background work | CLI and Desktop should share one execution/state pipeline. Cancellation and tool activity need structured events; summary/full-history selection is a presentation concern, not an address or lifecycle state. |
| OpenHands CLI/GUI | OpenHands exposes a shared SDK, CLI, and Local GUI over the same agent engine, while its delegation discussion uses the typed event stream to switch control between parent and delegated agent conversations ([repository](https://github.com/All-Hands-AI/OpenHands), [delegation design discussion](https://github.com/All-Hands-AI/OpenHands/issues/10433)) | A typed event stream is a useful UI projection surface, but an internal delegation event is not A2A conformance. Interactive child-conversation UX belongs after the message/task contract is stable. |

Cross-host conclusions:

1. **Delivery has two distinct commit points.** Active-turn steering may be accepted immediately, while idle delivery must survive process/session changes and be acknowledged only after model-visible consumption. Ph1 therefore keeps mailbox-first delivery even when an active parent can accept guidance.
2. **Address and display identity must remain separate.** Codex thread IDs, goose session IDs, and A2A task/context IDs all support the D7 choice: use the host-minted child session ID for routing and keep profile names display-only.
3. **Receiver policy remains authoritative.** Gemini's derived, subagent-labelled confirmation surface supports the ph1 rule that a received message cannot inherit the sender's tool approval.
4. **A2A interoperability begins at the binding.** Gemini CLI's remote-agent support is the most direct external host target. A future smoke test should point it at the opt-in ph3 loopback Agent Card and cover one completed Task, one INPUT_REQUIRED continuation, cancellation, and a rejected authentication attempt.
5. **Do not import foreign creation depth.** Several hosts prohibit recursive subagents or bound background concurrency. None is evidence for relaxing this repository's depth-1 creation stop; ph2 expands only the communication graph.

Potential host-project contributions discovered during this review:

- **Gemini CLI documentation/version matrix:** its remote-agent examples currently show an older protocol-version value while A2A v1.0 is released. Before filing anything, reproduce the current client's supported versions and search for an existing migration issue. If the client already supports v1, propose a documentation-only update plus a v1 INPUT_REQUIRED example; otherwise file a narrowly scoped compatibility question rather than claiming a bug.
- **No Codex, goose, or OpenHands issue yet:** their active-turn injection, subagent event, and UI patterns are useful comparative evidence, but this ph1 work did not reproduce an upstream defect in those projects.
## Duplicate-check checklist before any external submission

- [ ] Search open and closed issues in `a2aproject/A2A`, `a2aproject/a2a-tck`, and `a2aproject/a2a-js` using the exact protocol terms and likely synonyms.
- [ ] Re-check #1276, #1942, #1992, #95, #96, #1582, #1988, and any newly linked umbrella issue.
- [ ] Read the latest released specification and compare relevant changes on `main`.
- [ ] Reproduce the problem against the current upstream default branch, not only a downstream fork.
- [ ] Confirm that the gap belongs to the protocol, TCK, or SDK rather than host policy or UI behavior.
- [ ] Prefer a comment on an active umbrella issue over a duplicate issue.
- [ ] Check the repository's current `CONTRIBUTING.md`, issue template, labels, and required test commands.
- [ ] Remove private identifiers, logs, paths, policy constants, and implementation-specific names from the reproduction.
- [ ] For normative proposals, provide evidence from at least two independent implementations when practical.
- [ ] For TCK work, map every assertion to released normative text and a requirement ID.
- [ ] For custom transports, state whether the adapter is a documented A2A binding or only an embedded test seam.
- [ ] Ask maintainers to confirm scope before writing a large PR.
