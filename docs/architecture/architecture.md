# LVIS Architecture Document

LVIS is a desktop agent platform for local-first, project-aware AI work. The app
is built around one invariant: the host owns trust, storage, project identity,
and tool execution; plugins and renderer surfaces request capabilities through
explicit contracts.

Korean source history is preserved at
[docs/ko/architecture/architecture.md](../ko/architecture/architecture.md).

## System Goals

- Keep project context first-class across chat, memory, insights, work board,
  audit, and tool permissions.
- Let the user work from a desktop app without assuming that the process launch
  directory is the project root.
- Make the default workspace project the fallback when the user has not
  explicitly selected a project.
- Route every tool call through the same permission, audit, and execution path
  regardless of whether the tool is builtin, plugin-provided, or MCP-provided.
- Keep UI extension points powerful but bounded by host-owned APIs.
- Preserve deterministic fallbacks for provider, network, or plugin failures.

## Reference Product Hierarchy

Research for host-agent behavior starts with official documentation and current
shipped behavior of comparable coding-agent host products — CLI and desktop
agent hosts whose scope matches LVIS's. Those are the primary comparison set for
agent lifecycle, project handling, interaction, and desktop UX. IDE and
workspace products are secondary references: they may inform generic editor,
filesystem, and multi-root conventions, but they do not override host-agent
evidence. Record when a conclusion is an inference rather than a documented
primary-product contract.

## Layer Map

| Layer | Scope | Primary Responsibilities |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| User and desktop shell | Electron windows, tray, titlebar, settings, dialogs | Present the app, collect consent, and keep foreground/background behavior predictable. |
| Renderer app | Chat, Insights, Projects, Work Board, plugin slots | Render state from host APIs, never bypass host policy, and keep app workflows ergonomic. |
| Preload and IPC contracts | `src/preload`, `src/ipc`, shared channel constants | Expose narrow typed APIs from the main process to renderer code. |
| Relay and ingress | Loopback local API and app contract (`src/api`), CLI (`src/cli`), MCP loopback (`src/mcp`), and the main-process transport owners that accept non-renderer requests (`local-api-server.ts`, `conversation-command-port.ts`, the platform and tailnet bridges) | Accept external-origin requests, bind each to a trusted transport actor, and reach host services only through host-owned command entrypoints and the same permission and consent chokepoints as the renderer. These transports are transport-agnostic and hold no Electron runtime import, so the same host services can run under a windowless host process. |
| Host services | conversation loop, memory manager, session store, work board, plugin runtime | Own durable state, project identity, LLM orchestration, plugin lifecycle, and execution policy. |
| Tool execution and governance | Tool registry, executor, permissions, audit, sandbox helpers | Enforce one route for builtin/plugin/MCP tool calls and record decisions. |
| External integrations | LLM providers, MCP servers, marketplace, web auth, local indexers | Connect to outside systems through host-owned adapters and explicit credentials. |

## Process Boundaries

The renderer is a presentation surface. It does not read arbitrary files, mutate
settings directly, or execute tools. It calls preload APIs, which map to IPC
handlers in the main process. The main process validates arguments, resolves
current project context, and dispatches to host services.

Plugin UI code runs inside host-created shells. The host resolves plugin asset
URLs, applies theme tokens, and passes a bridge. Plugin code can request host
operations only through declared capabilities and HostApi methods.

MCP servers are treated as external tool providers. Their tools are normalized
into the same registry and are subject to the same permission and audit
requirements as other tools.

The relay and ingress layer serves surfaces other than the renderer: the
loopback local API, the CLI over that API, the MCP loopback, and the paired
platform and tailnet bridges. Each surface binds to a trusted transport actor
and reaches host services only through host-owned command entrypoints; it does
not carry its own project resolution, policy path, or consent surface. These
transports are transport-agnostic and free of Electron runtime imports, which is
what lets the same host services run under a windowless host process rather than
only inside the Electron boot. Consent for an external-origin mutating request
is still resolved at the single `ApprovalGate` chokepoint; when no consent
surface can present the request, the gate denies it for that call. The layer's
separation plan and the consent-surface security analysis live in
[docs/blueprints/headless-relay-separation.md](../blueprints/headless-relay-separation.md);
this section records only the boundary the rest of the host depends on.

## Project Identity

Project identity is not inferred from `process.cwd()`. LVIS is a desktop app,
so project scope comes from host-owned app state:

- selected project in the sidebar or project header;
- default workspace project when no explicit project is selected;
- normalized session metadata (`projectRoot`, `projectName`) for persisted
  conversations and insights;
- per-project memory, work-board reports, and token usage aggregation.

The canonical, normalized absolute path is the project identity. A basename is
display text only and must never be used to merge, remove, authorize, or recover
a root. Canonically equal paths deduplicate; different paths with the same
basename remain different projects. Their labels are disambiguated with parent
path context, expanding only as far as necessary to make each label clear. There
is no same-name fallback when a path is absent or stale.

Workspace roots follow one host-owned lifecycle:

1. Validate persisted roots at startup and again before runtime use. A confirmed
   missing path, `ENOTDIR`, or an existing non-directory is pruned. A transient
   access, device, network, or I/O failure is retained and audited for a later
   retry; uncertainty is not treated as deletion.
2. Add or re-add a root only after main-process validation confirms an existing
   directory and the permission store accepts its canonical path. A duplicate
   basename is allowed; a duplicate canonical path is not added twice.
3. Workspace-root lifecycle operations are serialized globally, including
   overlapping parent and descendant roots, so add, remove, and reconciliation
   cannot cross persisted snapshots. Removal shrinks both persistent and live
   scope. Before the settings entry is removed, durably prune routine
   directories and path-scoped grants under that root, then detach project
   metadata from every host-owned conversation namespace. A separately
   registered descendant root is an exclusion boundary and retains its own
   grants and routine scope. Missing cleanup services or any persistence failure
   retain the settings entry (fail closed). After settings persistence, revoke
   live scope and abort active turns that captured the removed root through the
   pre-removal global allow-list so a snapshot tool batch cannot continue.
4. Preserve conversation transcripts during the mandatory pre-removal metadata
   detachment. Under a metadata lock, clear only `projectRoot` and `projectName`
   from matching sessions, retain every other metadata field and the JSONL
   transcript, then reindex the session search row. A stale metadata write must
   not reattach a root after removal.
5. Project lists are derived only from the current validated root registry.
   Session metadata cannot synthesize a removed project row. Detached and
   intentionally unscoped sessions remain in the ungrouped Chats list; their
   stored identity is never reassigned by basename or silently rewritten to the
   default root. Clearing project metadata currently makes a detached session
   indistinguishable from a conversation that was unscoped from creation. This
   is an LVIS implementation choice, not a shared reference-product convention;
   the surveyed agent hosts support transcript preservation but none of them
   automatically reclassify such a session as a general conversation. When an unscoped conversation executes, the host binds that
   turn to the default workspace execution context.

## Conversation Loop

The conversation loop builds the system prompt, session history, project
context, memory context, available tools, and provider configuration for each
turn. It streams model output, collects tool calls, dispatches tool execution,
and commits turn artifacts back to the session store.

Important rules:

- Explicit project metadata must be attached before a project-scoped new
  session is persisted; a general conversation remains unscoped.
- Tool calls must not execute until the permission manager has resolved the
  decision path.
- Long histories are compacted through the structured compact path rather than
  silent truncation.
- Foreground turn-end notices stay out of the composer notification area; system
  notifications are reserved for background or non-focused app state.

## Memory

Memory is host-owned and project-aware. User preferences, long-term memories,
and work-board memory are read and written through storage seams, not renderer
filesystem access. Korean natural-language triggers remain supported where they
are part of runtime intent parsing, but default app-generated memory templates
are English.

Memory writes should preserve source provenance and avoid storing secrets,
credentials, raw private data, or unsupported claims.

## Insights

Insights is the default home for calendar-based activity review:

- calendar heatmap for token usage;
- selected-day usage details;
- daily LLM narrative with deterministic fallback;
- starred items for the selected day;
- conversation and project activity summaries.

Daily narratives are generated through host IPC and must fail closed to the
deterministic UI fallback when no provider is configured or generation fails.

## Work Board

The Work Board is a host domain, not only a plugin. It stores items, activity,
reports, and work-flow memory under host-managed storage. Reports default to
English prompts and English seeded examples. Per-project report paths use the
normalized project key.

The work board can still integrate with plugin and subagent flows, but the host
owns storage, approvals, and audit.

## Plugin Runtime

Plugin installation and runtime behavior are governed by manifest declarations,
capability checks, marketplace policy, and host APIs.

Key boundaries:

- The complete plugin-author TypeScript contract and its JSDoc are Host-owned in
  `src/plugins/public-contract.ts`. `src/plugins/types.ts` re-exports that
  surface and adds Host-private registry/marketplace DTOs. The SDK copies the
  public module mechanically and adds no declarations, documentation, aliases,
  or validation policy.
- plugin code cannot invent its own identity when calling HostApi;
- installed plugin assets are loaded through host-approved URLs;
- plugin tools must declare schemas (pure MCP `Tool` objects); per-tool category
  is not a manifest field — the host classifies the effective category per
  invocation;
- natural-language keywords never activate plugin scope or preload a Tool.
  Bundled `manifest.skills` contribute instructions, while host-selected plugin
  scope and `tool_search` control model-visible Tool discovery;
- plugin UI can render in host slots but cannot bypass permission review;
- optional `manifest.onboarding.firstTask` copy is inert, localized metadata:
  the host may prefill the visible composer, but it never auto-submits or invokes
  a tool, and undeclared or unusable plugins produce no proposal;
- marketplace metadata should not override local policy or managed-plugin rules.
- boot verifies each installed payload's receipt before parsing its manifest.
  Receipt hashing and manifest validation run with bounded concurrency, but
  successful results and failures are projected in registry order. A rejected
  payload never contributes tool/event ownership or dependency capability, and
  an accepted manifest is parsed only once for that boot load.
- plugin replacements keep the prior registry row in a strict `pendingUpdate`
  state from the pre-promotion boundary through registry commit. Runtime and
  HostApi trust caches skip pending rows, while uninstall/bundle planners retain
  the full row and its references. Boot clears the marker only after the exact
  receipt snapshot verifies every covered file in the owned plugin directory,
  restoring directory bytes before publishing that receipt when a validated
  backup is required. A verified retry preserves the original predecessor and
  grants until its replacement registry commit; unresolved live bytes are
  journaled as cleanup-only ownership and never become a recovery snapshot.
  Recovery backup IDs, names, and parent directories are validated exactly.
  Every obsolete post-commit or superseded directory is retained in the
  non-restorable `pendingCleanup` journal until direct removal or tombstone
  staging succeeds. Direct and bundle uninstall stage the live directory plus
  all recovery/cleanup-owned paths before deleting the row; unresolved recovery
  backups are never handled by the orphan tombstone sweeper.
- managed boot synchronization uses one boot-local promise tail. Recovery
  journals and retirement state are bound first; compatible managed artifacts
  then commit durable bytes, receipt, and registry state without candidate
  publication or execution. Admitting runtime start synchronously seals the
  tail before awaiting it, so later managed commits reject before mutation and
  `startAll` runs exactly once against the final committed snapshot. Renderer
  retry is missing-only: any registry row or owned artifact counts as installed,
  regardless of enabled or runtime-start state. Only a truly structural missing
  repair may use the generic generation lifecycle to activate the new artifact
  before reporting retry success. A failed runtime start remains sealed and is
  never retried or reported as started implicitly.
- a plugin artifact may declare plugin-owned `skills`, `hooks`, and `mcpServers`
  as `{id,path}` entries. IDs are local to the tuple `(plugin id, plugin version,
  contribution kind)` and paths are normalized relative to the verified plugin
  root. The Host rejects absolute/traversing/ambiguous paths, declaration or
  archive-member collisions, links/devices, missing members, and a Skill
  directory without `SKILL.md`. A contribution-free manifest remains valid.
- declaration and signature are not execution authority. Skills contribute
  instructions only; Hook trust is bound to the exact owner/version/local ID and
  command-policy fingerprint; MCP connection approval is bound to the exact
  owner/version/local ID and static policy fingerprint. Candidate preparation
  for MCP is parse/fingerprint-only and performs no spawn, network, discovery,
  registry write, or plugin execution.
  An `mcpServers[].path` descriptor is one JSON object containing a standard
  `stdio` or Streamable HTTP MCP config without `id`, `apiKey`, `sandboxRoot`,
  or `allowPrivateNetworks`; the Host derives a generation-scoped server ID and
  an ephemeral strict governance rule. Exact approval connects it without
  adding it to the user's global `servers.json`. A failed connection is a typed
  degraded projection with zero tools and does not roll back the plugin bundle.
- plugin code, handlers, materialized Skill bytes, Hook projections, static MCP
  descriptors, and operation policy belong to one immutable active generation.
  Every dispatch first acquires a lease on that generation. Lifecycle transitions
  prepare a hidden candidate, block new leases, durably commit bytes/receipt/
  registry identity, then publish with one non-throwing in-memory pointer
  assignment. Existing predecessor leases may finish; teardown waits for their
  drain and remains journaled/retriable if fallible cleanup fails. A crash before
  the durable commit reconstructs the predecessor; a crash after it reconstructs
  only the committed verified generation.
- renderer-to-plugin method calls are allowlisted by each tool's
  `_meta.ui.visibility`: only app-visible tools (visibility includes `"app"` —
  the union of app-only `["app"]` and dual `["model","app"]`) are
  renderer-invokable;
- an app-only **non-status** tool (visibility exactly `["app"]`) is driven by a
  direct UI activation only and cannot be invoked from a plugin-origin
  `ctx.callTool` — give it `"model"` visibility (`["model","app"]`) for governed
  model/plugin invocation (the auth `statusTool` is exempt: status polling skips
  the user-activation gate and runs on a plugin-origin chain) (#1556);
- long-lived plugin workers are spawned only through HostApi `spawnWorker`;
  filesystem read grants must be declared explicitly as `allowReadPaths` and are
  never inferred from argv.

## Main-process composition and boot readiness

TypeScript under `src/` must have no static runtime-import strongly
connected components. `bun run check:import-cycles` enforces this in the build
gate while ignoring type-only imports. Shared theme replay state and native
window event listeners therefore live in leaf modules; compatibility barrels
may re-export them but native window construction imports the leaves directly.

Reverse calls from menu and main-window modules into native window actions go
through the native-window coordinator configured once by `main.ts`; the tray
remains the one-way composition owner. Calls before configuration and repeat
configuration are contract errors. Boot uses a staged `BootContext`, then an
exhaustive own-property readiness assertion before `assembleAppServices`; a
missing producer is reported by field name instead of leaking `undefined` into
the running application.

## Current Large-Module Ownership

The remaining high-churn surfaces keep one state owner while delegating focused
implementation units:

| Stable surface | Focused owners |
|------------------------------------------ |------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine/turn/query-loop.ts` | owns the round loop plus the meta-tool intercepts (`request_plugin`, `tool_search`) and their cross-agent approval gate — none has a consumer outside it; `tool-scope.ts` and `compaction.ts` own their respective policies |
| `plugins/runtime/index.ts` | invocation/query facade over `runtime-lifecycle.ts` and the single shared state owner in `runtime-state.ts` |
| `preload/internal-surface.ts` | stable world builders and first-frame primes; `internal-api-surface.ts` owns the internal renderer API object |
| `data/settings-store.ts` | persistence/service facade over `settings-defaults.ts` and pure normalization in `settings-normalization.ts` |
| `ui/renderer/components/ChatSidePanel.tsx` | panel/tab composition over preview, layout, and workspace components in `chat-side-panel-*.tsx` |

Every implementation unit remains below 1,600 lines. The split does not add a
second state store, runtime alias, IPC channel, or policy path.

## Sub-agent Messaging (A2A)

Sub-agents are in-process child `ConversationLoop`s. Messaging expands the
**communication** graph between them; it never expands the **creation** graph,
which stays hard-stopped at depth 1. Full design detail, decision record and
state-transition table live in
[docs/blueprints/a2a-subagent-messaging.md](../blueprints/a2a-subagent-messaging.md);
this section records only the contract the rest of the host depends on.

**Four messaging edges.** Each is a distinct tool with a distinct authority:

| Edge | Mechanism | Authority |
|---|---|---|
| child → parent | `agent_send(to: <parent>)`, optionally `waitForReply` for a question | a child reports to its own principal |
| child → sibling | `agent_send(to: <siblingChildSessionId>)` | peers under one origin; the receiver never agreed to act on it, so it force-asks |
| parent → child | `agent_guide` — injected live into a running child, or queued in the durable directive mailbox for a suspended one | the parent amends the task it authored |
| parent → suspended child | `agent_spawn(resumeId=…)` continuation instructions | re-hydrates and continues the same child |

`agent_send` is registered model-visible for children only; `agent_guide` is
parent-only and blocklisted out of every child registry. Addresses are always
the host-minted `childSessionId` (`sub-<sha256(origin)[:8]>-<uuid>`) — a profile
name is display text, never an address.

**Wake drain invariant.** A queued child message can start a parent turn when
autonomous wake is enabled. The drain has one invariant: a per-parent dirty
token, spent before dispatch, is the progress guarantee — a wake that consumes
nothing must stop, and every trigger that legitimately owes a delivery must
still reach exactly one wake. Pinned by
`src/engine/__tests__/a2a-wake-drain.test.ts`.

**Mailbox durability.** Both the sibling mailbox and the parent directive
mailbox persist to disk, so a message survives the suspension it was written
across. A directive is only accepted for a child whose resume can still happen
— task state, suspension reason, and both resume-axis counters — because the
mailbox's only delivery path is a resume that would otherwise refuse it. On the
delivery side an entry is acknowledged when the segment that carried it reached
a conclusion, and a terminal child's pending entries are discarded outright.

**Parent rounds are unbounded.** A round budget is a sub-agent concept: the
runner assigns `maxRounds` per child, and hitting it is a `round-cap` budget
suspension carrying a `resumeId`. A parent turn passes no `maxRounds` and runs
`PARENT_UNLIMITED_ROUNDS` — there is no global round constant, so a parent turn
never reaches `round-cap`.

## Tool Governance

All tool execution flows through the registry and executor:

1. resolve the tool by name and source;
2. validate input schema and resolve the effective category;
3. build permission context from trust origin, project, headless state, and
   policy mode;
4. run hard gates before any reviewer or user prompt;
5. ask the user or reviewer where policy requires it;
6. execute through the controlled adapter;
7. record audit and telemetry output.

The source of a tool changes display and audit metadata; it does not create a
separate policy bypass.

### Sub-agent approval chain (three tiers)

A tool call raised by a sub-agent's turn passes through up to three deciders.
Each tier only ever narrows what the next one is asked:

1. **Tier 1 — automatic review.** The permission manager and the reviewer
   classifier decide as they do for any other call. A decision of allow ends
   the chain here; the sub-agent's parent is not consulted and no dock appears.
2. **Tier 2 — parent adjudication.** An `ask` that survives tier 1 and clears
   every host-side precondition is put to a host-composed side turn with no
   tools and one round, run on the *reviewer* model and prompted to stand in
   for the parent (`src/permissions/parent-adjudicator.ts`). "The parent" is
   therefore a role, not a session: the only parent-derived evidence is the
   child's title and a truncated copy of the task the parent wrote when it
   spawned the child — not the parent's model, system prompt, or history. That
   is the ceiling's real basis, and the reason `maxVerdict` stays low. The
   stage runs inside `ApprovalGate.requestAndWait`, after the away-authority
   block and before the pending entry is created, so a parent-answered call
   never reaches a dock.
3. **Tier 3 — the user.** Anything the parent did not settle continues to the
   approval dock as it would have without tier 2 — later than it would have,
   and carrying an outbound `parentEscalation` notice so the dock can tell the
   user that a stage they never saw has already run, and how it ended.

The child blocks on the same `requestAndWait` call for all three tiers; no
suspension or resume is involved, and the parent is never woken, so a busy
parent cannot deadlock its own child.

| Invariant | Where it is enforced | Why |
| --------- | -------------------- | --- |
| The ceiling is applied before the parent is asked | The gate derives every condition itself — request kind and category, mode, remote origin, forced-explicit and one-shot substrates, and the verdict ceiling — and never from the caller's eligibility flag | A parent may only narrow a decision the host was already willing to delegate; a caller that asserts eligibility wrongly widens nothing. |
| A parent answer is allow-once or deny-once, never a rule | `askParent` returns decisions with no `rememberPattern` | A durable rule minted for a user who never saw the request would outlive the call the parent actually judged. |
| No child-authored PROSE reaches the adjudication prompt | The only sentence in the evidence is the parent's spawn task. The child's tool arguments are the unavoidable exception — they are the call being judged — so they are masked and carried under the key `argumentsAuthoredBySubAgent`, beneath a system prompt that names the payload untrusted data rather than instructions | Evidence a child can narrate is evidence a child can use to argue for its own approval. What cannot be withheld is labelled as the requesting party's claim instead of presented as fact. |
| Human-only classes stay human-only | Directory-scope grants, rationale cards and agent-action requests, `meta`-category tools, the `ask_all` and `plan` modes, remote-controller origins, forced-explicit and bound one-shot substrates, and any ask with no tier-1 verdict never enter tier 2 | These are the cases where the decision is the user's by construction, not a judgement about whether a call serves the child's task. |
| Every failure that leaves a turn to answer ends at the user | Timeout, spent budget, unparseable answer, missing adjudicator, provider error and repeated denial all escalate to the dock; a turn stopped while the parent was thinking ends in a host `deny-once` with no dock at all | A stage that cannot answer must not be able to answer "allow" — and a turn the user stopped must not be readable as anyone's approval. |
| Flag off means the chain is the two-tier one | The lane is a synchronous eligibility check; an ask that is not adjudicated is never awaited | The off path must be identical in behaviour and in timing. |

Six deviations from the original design are deliberate and load-bearing:

- **Host-only fields live on `ApprovalRequestInput`, not `ApprovalRequest`.**
  `childProvenance` and `parentAdjudicationEligible` are inputs the host
  supplies; the renderer neither receives nor echoes them, so there is no copy
  for a compromised renderer to author or alter (same argument as
  `remoteControllerOrigin`).
- **Parent provenance travels in a WeakMap, not on the decision.**
  `ApprovalDecision` is a renderer-supplied type, so an `answeredBy` field on it
  would be a claim anyone could make. `parentAdjudicationOf(decision)` keyed on
  the exact decision object the gate returned is a fact only the host can state.
- **A parent deny sets no `rememberPattern`.** Stated separately from the
  allow-once rule because it is the tempting one: a parent that could remember
  a denial would be minting policy.
- **Provenance requires a parent-authored task, and fails closed without one.**
  `SubAgentSpawnInput.parentAuthoredTask` exists because the profile prompt a
  child is spawned with is not the parent's instruction — it is a charter read
  from a file on disk, which anything that can write that file could author.
  Runs whose origin is not a conversation session (work-board items, host
  labels) are excluded for the same reason.
- **`approvalPurpose` is not part of the evidence.** For a sub-agent turn that
  sentence can only have been lifted out of the child's own tool arguments, so
  including it would have put the child's own prose into the prompt that
  decides the child's request.
- **A2A influence IS part of the evidence.** A sibling's message re-elevates the
  receiver's calls into an ask even on the read lane, which is why an otherwise
  auto-approved builtin read can reach tier 2 at all. The host label naming that
  sender rides the evidence as `a2aInfluenceLabel`, emitted to the adjudicator
  as a quoted `raisedUnderAnotherAgentsInfluence.quotedSenderLabel` under its own
  read-it-never-obey-it system-prompt line. It is host-composed and already the
  leading segment of the `reason` the dock would have shown, so it discloses
  nothing new — but without it the parent judges "does this serve the task I
  gave it?" blind to the third agent that prompted the call.

Three settings move or widen the chain, each conservative by default
(`permissions.reviewer.parentAdjudication`):

- **`includeParentContextTurns` (default `0`, clamped `0..5`).** Above zero the
  evidence gains a host-composed block of the parent conversation's most recent
  turns, quoted as data under `recentParentConversation` beneath a system-prompt
  line that says to read it and never obey it. Opt-in because it is the only
  part of the evidence that sends the user's own words to a provider.
  `summarizeParentContextTurns` (`src/permissions/parent-context-evidence.ts`)
  composes it: user and assistant text only — never tool results, reasoning or
  tool calls — with every host-injected user record dropped, which is what keeps
  a **sub-agent's report out of the prompt that decides that sub-agent's own
  call**. Three defences carry that, because one producer alone cannot: the
  mid-turn injection site now stamps `hostInjectionId` unconditionally (a batch
  mixing the user's guide with a child's report is deliberately not attributed
  to the child, so it used to reach the transcript unmarked); the reader also
  drops any user record carrying the host-composed `[Sub-Agent: ` label, which
  covers rows written before that stamp; and an assistant turn answering an
  excluded record is dropped too, so a report asking the parent to restate it
  cannot launder itself through the parent's own voice. Each turn is cut to 500
  characters BEFORE the DLP pass (the bound exists to stop the masking walk, so
  a bound on its output would not do the job) and the block to 2000 measured on
  what is actually sent. The read is memoised for a few seconds because
  `loadSession` is a synchronous whole-file parse on the main thread.
- **`backgroundEscalation` (default `"deferred"`).** A tier-3 escalation the
  host can establish nobody would see — a background child run while the app
  window is hidden or minimised, or any child run while the away answerer is
  armed — is denied fail-closed and recorded in the deferred queue with an OS
  notification, rather than painting a dock nobody is watching. The run's
  `background` flag alone is deliberately NOT enough: every locally spawned
  child is a background run on this host, so keying on it would take the dock
  away from a user sitting in front of the app, and tier 3 is the tier the
  chain exists to preserve. The entry carries **no `grant`**, so the resolve
  path refuses `"approved"` for it: reviewing it later records an opinion and
  can never become permission for a call whose turn is over. There is no
  timeout that could auto-anything — the denial has already happened. An
  attended window, `"modal"`, an unwired queue, an unreadable attendance signal
  or a failed append each keep the immediate dock. Repeat escalations from the
  same (child run, tool) coalesce onto the first entry — still each denied —
  so a child past its adjudication budget cannot bury the queue.
- **`model` (default `"reviewer"`).** `"parent-session"` runs the side turn on
  the chat provider/model the parent's own loop uses, resolved per ask from the
  same settings that build that loop's provider; unresolvable resolves to
  escalate, never to a fallback model. Zero tools, one round and the strict JSON
  parse are identical either way. It is available in reviewer modes that wire no
  LLM of their own — but NOT in `disabled`, whose classifier returns a
  pass-through LOW for every call: a tier-2 ceiling computed from a verdict that
  assessed nothing is not a ceiling. Cost note: it bills the (usually larger)
  chat model once per adjudicated call, bounded by `maxPerChildRun`.

One known gap remains, recorded so it is not mistaken for design: a child run's
budget counter is never released when the run ends. The origin conversation id
handed to the adjudicator is no longer dead — it is what `"parent-session"`
resolves its target from.

The chain end to end — tier-1 auto-approve, tier-2 allow, tier-2 deny, tier-3
escalate — is regression-locked by
`src/tools/__tests__/executor-parent-adjudication.test.ts`; the gate's own
bounds live in `src/permissions/__tests__/parent-adjudication-gate.test.ts`,
and the three settings above in
`src/permissions/__tests__/parent-adjudication-options.test.ts` +
`parent-context-evidence.test.ts`.

### MCP↔plugin execution parity (invariant)

External MCP-server tools (`source:"mcp"`, `mcp-tool-adapter.ts`) and in-process
plugin loopback tools (`source:"plugin"`, `plugin-tool-from-mcp.ts`) are
registered into the one tool registry and executed through the single
`ToolExecutor` invocation pipeline. `executor.ts` is the stable public barrel;
the implementation delegates preparation/path policy, authorization/rationale,
and execute/finalize to explicit ordered stages. Both sources converge at the
same ordered chokepoints — Layer-1 deny, ApprovalGate, audit, and the effect-ledger shadow —
and the divergences between them are input-only, driven by host-derived
source-identity signals, never a separate code path or policy bypass. An
external MCP server is a lowest-trust foreign peer, so the host assigns it the
`low` trust tier (`trustFromSource`; a first-party plugin is `medium`) and treats
its risk-classification input as untrusted (`category:"network"`); the effect
ledger records a plugin invocation as host-observable but an out-of-process MCP
invocation as `hostObservable:false`; and the identity field is `pluginId` for a
plugin versus `mcpServerId` for an MCP tool.

The one asymmetry that is a _path_ fork rather than a pure input difference is the
foreground reviewer AUTO-APPROVE lane, and it is a direct consequence of the
sanctioned trust-tier split: `PermissionManager.categoryBasedDecision`
short-circuits every low-trust (MCP) invocation with a bare `ask` carrying no
reviewer route, so an MCP tool is categorically excluded from the reviewer
auto-approve lane and escalates straight to the ApprovalGate, while a
medium-trust plugin may enter the lane (the reviewer classifier runs, keyed on
the host-computed `ownerPluginSandboxRoot`) and, on any non-LOW verdict, escalates
to the SAME gate. A low-trust foreign peer is therefore never silently
auto-approved; both sources still converge at the user-facing gate. There is no
MCP analog of the app-only dispatch bypass — external servers declare no
app-visible tools. This whole invariant (deny/gate/audit/effect-ledger convergence plus the
trust-gated lane) is regression-locked by
`src/tools/__tests__/executor-mcp-plugin-parity.test.ts`.

## OS Execution Sandbox And Plugin Workers

The OS execution sandbox is backed by
`@anthropic-ai/sandbox-runtime` (ASRT). The active sandbox capability is
published as `kind: "asrt"` with explicit `confines` dimensions. macOS and
Linux ASRT substrates provide filesystem, process, and network confinement.
Windows srt-win provides filesystem and network confinement but no process
confinement, so shell/process relaxation must remain stricter than filesystem
or network-bearing tool relaxation.

Plugin read-relaxation is narrower than the host-shell capability. The
foreground plugin effect-boundary may replace a pre-exec ask only when
`hostClassifiesRisk` is enabled and
`isActiveSandboxFilesystemContainedForPluginEffects(tool)` returns true for
that exact tool. A process-global "sandbox active" signal is not sufficient.
The plugin effect provider requires a host-owned `Tool.workerId` and a matching
`pluginId/workerId` that the main process currently tracks as ASRT-wrapped.
Ordinary in-process plugin tools, degraded hosts, and sandbox-off hosts keep
the known-safe pre-exec ask path.

`spawnWorker` is the only host primitive that can establish that worker-backed
plugin substrate. macOS and Linux workers use an ASRT-wrapped Unix-domain-socket
control path. Windows workers keep TCP control, but their filesystem access is
scoped through a per-worker holder PID ACL grant using ASRT's Windows
`grantWindowsAcl`/`revokeWindowsAcl` primitives, then the command is wrapped
through srt-win. The holder command must be launched through a pinned System32
binary and its lifecycle is part of the worker's confinement proof: if the
holder exits or errors, the host must revoke grants, unmark the worker, and
terminate the wrapped worker.

## Security And Audit

Security-sensitive areas are intentionally centralized:

- `src/permissions` for policy and approval decisions;
- `src/audit` for durable audit records;
- `src/ipc` and `src/preload` for process boundary contracts;
- `src/boot` for startup wiring and policy initialization;
- tool executor and sandbox helpers for runtime enforcement.

Changes spanning these areas merit proportionate cross-cutting review. That
review is advisory, never a merge gate. Documentation-only mirrors under `docs/ko`
are excluded from naming-process gates because they preserve historical source
text; production paths remain covered.

## Documentation Language Policy

English is the canonical default for app docs, generated examples, comments,
logs, and user-facing fallback copy. Korean source documents are retained under
the mirrored `docs/ko` path and linked from the default pages. Runtime Korean
support remains in locale catalogs, intent parsing, and keyword matching where
the app must understand Korean user input.

## Verification Expectations

Architecture changes should normally be verified with:

- targeted tests for the changed contract;
- `bun run typecheck`;
- `bun run check:i18n-catalog` when UI copy or catalogs change;
- `bun run test` for broad cross-cutting changes;
- `git diff --check origin/main...HEAD` for PR-range whitespace checks.
