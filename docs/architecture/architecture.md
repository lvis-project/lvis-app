# LVIS Architecture Document

LVIS is a desktop agent platform for local-first, project-aware AI work. The app
is built around one invariant: the host owns trust, storage, project identity,
and tool execution; plugins and renderer surfaces request capabilities through
explicit contracts.

The large Korean v0.4.1 document is preserved only as a historical source
snapshot at [docs/ko/architecture/architecture.md](../ko/architecture/architecture.md).
This file is the current architecture contract.

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
shipped behavior from Codex CLI/Desktop, Claude Code/Desktop, Hermes Agent
Desktop, goose Desktop, GitHub Copilot, and Google Antigravity. These are the
primary comparison set for agent lifecycle, project handling, interaction, and
desktop UX. IDE and workspace products are secondary references: they may inform
generic editor, filesystem, and multi-root conventions, but they do not override
host-agent evidence. Record when a conclusion is an inference rather than a
documented primary-product contract.

## Layer Map

| Layer | Scope | Primary Responsibilities |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| User and desktop shell | Electron windows, tray, titlebar, settings, dialogs | Present the app, collect consent, and keep foreground/background behavior predictable. |
| Renderer app | Chat, Insights, Projects, Work Board, plugin slots | Render state from host APIs, never bypass host policy, and keep app workflows ergonomic. |
| Preload and IPC contracts | `src/preload`, `src/ipc`, shared channel constants | Expose narrow typed APIs from the main process to renderer code. |
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
   Codex, Claude, Copilot, Hermes, goose, and Antigravity evidence supports
   transcript preservation but not automatic reclassification as a general
   conversation. When an unscoped conversation executes, the host binds that
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
| `engine/turn/query-loop.ts` | `intercepted-meta-gate.ts` owns cross-agent meta-tool approval; `tool-scope.ts`, `knowledge-cap.ts`, and `compaction.ts` own their respective policies |
| `plugins/runtime/index.ts` | invocation/query facade over `runtime-lifecycle.ts` and the single shared state owner in `runtime-state.ts` |
| `preload/internal-surface.ts` | stable world builders and first-frame primes; `internal-api-surface.ts` owns the internal renderer API object |
| `data/settings-store.ts` | persistence/service facade over `settings-defaults.ts` and pure normalization in `settings-normalization.ts` |
| `ui/renderer/components/ChatSidePanel.tsx` | panel/tab composition over preview, layout, and workspace components in `chat-side-panel-*.tsx` |

Every implementation unit remains below 1,600 lines. The split does not add a
second state store, runtime alias, IPC channel, or policy path.

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

Changes spanning these areas require cross-cutting review. Documentation-only
mirrors under `docs/ko` are excluded from naming-process gates because they
preserve historical source text; production paths remain covered.

## Documentation Language Policy

English is the canonical default for app docs, generated examples, comments,
logs, and user-facing fallback copy. Korean source documents are retained under
the mirrored `docs/ko` path and linked from the default pages. Runtime Korean
support remains in locale catalogs and feature-owned parsing where the app must
understand Korean user input. Locale handling never selects plugin scope or
preloads a Tool.

## Verification Expectations

Architecture changes should normally be verified with:

- targeted tests for the changed contract;
- `bun run typecheck`;
- `bun run check:i18n-catalog` when UI copy or catalogs change;
- `bun run test` for broad cross-cutting changes;
- `git diff --check origin/main...HEAD` for PR-range whitespace checks.
