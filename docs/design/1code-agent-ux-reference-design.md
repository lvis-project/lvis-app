# 1Code Agent UX Reference Design

> Date: 2026-06-26 KST
> Scope: 1Code의 agent-client UX와 기술 구조를 LVIS 관점에서 해석한 참고 설계.
> Status: Design reference. 구현 스펙이 아니라, 다음 PRD/blueprint의 입력 자료다.

## 1. Conclusion

1Code는 Claude Code나 Codex 터미널을 그대로 iframe/terminal처럼 노출하는 제품이 아니다. 동시에 자체 LLM agent loop를 처음부터 전부 구현한 것도 아니다.

정확한 구조는 hybrid다.

- 뒤쪽 runtime은 Claude Code SDK와 Codex ACP/binary를 사용한다.
- provider stream을 자체 `UIMessageChunk`/tool part 형태로 변환한다.
- text, thinking, bash, edit/write diff, plan, todo, MCP, ask-user-question, sub-agent/task 등을 자체 React 컴포넌트로 렌더링한다.
- Git, diff, terminal, plan, file viewer, MCP 같은 작업 객체는 chat transcript 밖의 Details Sidebar에 지속적으로 배치한다.

LVIS에 바로 참고할 핵심은 "Claude/Codex를 붙이는 법"보다 "agent가 한 일을 transcript와 별도 작업면으로 분리해 검토/조작 가능하게 만드는 법"이다. LVIS는 이미 provider-neutral stream, first-class reasoning, WorkGroup, permission governance, MCP app view, message queue, session todo, sub-agent card를 갖고 있으므로 1Code를 복제할 필요는 없다. 부족한 쪽은 변경사항/플랜/파일/실행 로그를 한 곳에서 계속 추적하는 workspace workbench다.

## 2. Evidence Base

분석 대상:

- Upstream: https://github.com/21st-dev/1code
- Local snapshot: `/private/tmp/1code-analysis`, cloned on 2026-06-26.
- LVIS repo: `/Users/ken/workspace/GIT/github/lvis-project/lvis-app`

### 2.1 1Code evidence

| Area | Evidence | Meaning |
| --- | --- | --- |
| Product claim | `README.md:11-33`, `README.md:52-68`, `README.md:71-83` | 1Code의 주요 UX는 multi-agent, visual diff, worktree isolation, built-in git, integrated terminal, message queue, plan mode, visual thinking, sidebar sub-agent display다. |
| Binary/runtime dependency | `package.json:23-26`, `README.md:140-153` | Claude/Codex binaries are required. Agent functionality fails if skipped. |
| Claude runtime | `src/main/lib/trpc/routers/claude.ts:1733-1774`, `:1976-2020` | Claude preset/system prompt, AGENTS.md append, MCP servers, env, permission mode, Claude executable path, resume/fork options are passed into SDK query. |
| Codex runtime | `src/main/lib/trpc/routers/codex.ts:1255-1267` | Codex is run through ACP provider with command path, auth env, cwd, MCP servers, persisted session. |
| Stream transform | `src/main/lib/claude/transform.ts:170-188`, `:191-230` | Tool input start/delta and thinking deltas are converted into UI chunks instead of being shown as raw terminal output. |
| Tool normalization | `src/shared/codex-tool-normalizer.ts:3-14`, `:121-152` | Codex verbs are mapped into canonical tool names such as Bash, Glob, Grep, Edit, Write, Thinking, WebFetch, and MCP names. |
| Renderer dispatch | `src/renderer/features/agents/main/assistant-message-item.tsx:680-848` | Each part type has a custom renderer: Bash, Thinking, Edit/Write, WebSearch, PlanWrite, TodoWrite, AskUserQuestion, MCP, etc. |
| Details Sidebar | `src/renderer/features/details-sidebar/details-sidebar.tsx:54-201` | Work state is not only chat. Widgets include info, todo, plan, terminal, diff, MCP, files. |
| Changes widget | `src/renderer/features/details-sidebar/sections/changes-widget.tsx:29-47`, `:140-253` | Changed files can be selected, marked viewed, opened, committed, committed+push from sidebar. |
| Diff performance | `src/renderer/features/agents/ui/agent-diff-view.tsx:1561-1663` | Large diff UI uses deferred values and bounded prefetch of file contents. |
| Thinking UX | `src/renderer/features/agents/ui/agent-thinking-tool.tsx:40-91`, `:97-164` | Thinking expands while streaming, auto-collapses on completion, shows preview and elapsed time. |
| Bash UX | `src/renderer/features/agents/ui/agent-bash-tool.tsx:25-55`, `:100-124`, `:132-230` | Bash command is summarized, paths are shortened, input streaming shows "Generating command", output is capped until expanded. |

### 2.2 LVIS evidence

| Area | Evidence | Meaning |
| --- | --- | --- |
| Turn contract | `docs/architecture/architecture.md:734-753` | Renderer receives standard events: reasoning, text, tool_start, tool_end, assistant_round, done. |
| First-class reasoning | `docs/architecture/architecture.md:803-810` | Reasoning is a separate event, persisted as thought, not just a text flag. |
| WorkGroup contract | `docs/architecture/architecture.md:1087-1106` | Intermediate reasoning/tool/mid-turn text is separated from the final assistant answer. |
| Design system | workspace-root `design.md:44-68` | LVIS uses one semantic intent axis: low, med, high, info, accent, neutral. |
| Reasoning card | `src/ui/renderer/components/ReasoningCard.tsx:6-23` | LVIS intentionally starts reasoning collapsed, including while streaming. |
| Tool group | `src/ui/renderer/components/ToolGroupCard.tsx:18-70`, `:127-220` | LVIS already shows per-tool duration, source badge, status badge, compact result, HTML preview, file diff, MCP app view. |
| File edit diff | `src/ui/renderer/components/FileEditDiff.tsx:1-17`, `:34-104` | LVIS has inline edit/write/apply_patch diff plus sidecar fetch for large write_file diffs. |
| Session todo | `src/ui/renderer/components/SessionTodoPanel.tsx:1-25`, `:107-183` | LVIS has a live assistant checklist with collapsed active-step focus. |
| Message queue | `src/ui/renderer/components/MessageQueuePanel.tsx:1-20`, `:65-117` | LVIS already supports in-flow message queue while an agent is busy. |
| Sub-agent card | `src/ui/renderer/components/SubAgentCard.tsx:1-10`, `:52-115` | LVIS already has sub-agent lifecycle cards. |
| Composer action bar | `src/ui/renderer/components/InputActionBar.tsx:1-21`, `:180-220` | LVIS composer has unified command/persona/attach/thinking/cancel/send and status sub-row. |

## 3. What LVIS Already Covers

The following 1Code ideas should not be treated as gaps.

| 1Code capability | LVIS current state | Design decision |
| --- | --- | --- |
| Visual tool execution | `ToolGroupCard` already renders per-tool rows, status, duration, source, collapsible input/result. | Improve micro-states, do not replace. |
| First-class thinking | Architecture and `ReasoningCard` already make reasoning first-class. | Keep LVIS collapsed-by-default philosophy. |
| Message queue | `MessageQueuePanel` already supports queueing and send-now. | Continue using in-flow input-cluster pattern. |
| Sub-agent visibility | `SubAgentCard` already shows spawn lifecycle and summaries. | Add aggregate sidebar view only if multi-agent work becomes common. |
| MCP app/tool surface | `McpAppView` and MCP tabs already exist. | LVIS has stronger governance; do not weaken it. |
| Permission review | LVIS has explicit permission review/status/deferred approval flows. | Do not copy 1Code bypass-permission defaults. |
| Inline edit diff | `FileEditDiff` and write_file sidecar already exist. | Add workspace-wide changes view, not another inline diff. |

## 4. Highest-Value Gaps And Opportunities

### P0 - Workspace Evidence Rail

1Code's strongest UI pattern is not a single card. It is the persistent right-side Details Sidebar. The sidebar turns transient agent events into stable objects: plan, todo, terminal, diff, MCP, files.

LVIS currently keeps most agent evidence in the chat flow or in separate settings/dialog surfaces. That is readable, but it makes longer work harder to audit because the user must scroll the transcript to answer:

- What changed?
- What is still running?
- Which files should I inspect?
- What plan was approved?
- Which MCP artifact/result is relevant now?

Recommendation:

Introduce a LVIS "Evidence Rail" as a right-side workspace surface. It should be a calm, dense, resizable rail, not a decorative card column.

Default widgets:

| Widget | Source | Purpose |
| --- | --- | --- |
| Current Work | SessionTodo, SubAgentSpawn, active tool group summaries | Shows what the assistant is doing without expanding transcript internals. |
| Changes | file edit sidecars, future git status, write/edit/apply_patch events | Shows file-level deltas across the whole turn/session. |
| Plan | latest plan markdown, `todo_session_write`, plan-mode output | Review/approve/compare plan without scrolling. |
| Artifacts | `render_html`, MCP UI resource, generated files/images | Keeps rendered outputs inspectable. |
| Permissions | deferred approvals, last review result, current mode | Makes governance state visible without modal hunting. |
| Context | token ring detail, active model/persona, attached files | Moves dense state out of the composer status row when needed. |

Interaction rules:

- Main chat remains the narrative: question, work summary, final answer.
- Evidence Rail owns manipulation: inspect diff, mark viewed, open artifact, approve plan, retry artifact load.
- The rail must collapse to an icon strip on narrow desktop and a bottom sheet on mobile-sized windows.
- The rail must reuse LVIS intents from `design.md`; do not introduce a Cursor-like blue/purple-only palette.
- No nested cards. Widgets are compact panels inside one rail surface.

Acceptance criteria:

- A user can answer "what changed?" without scrolling the chat.
- A user can open the latest plan and latest artifact in one click.
- Chat still reads cleanly with the rail closed.
- No existing WorkGroup behavior regresses.

### P0 - Workspace Changes Workbench

1Code has an opinionated changes surface: file list, viewed state, selected-for-commit state, commit/push action, per-file diff, and open-in-editor/finder affordances.

LVIS already has inline diffs for specific tools, but lacks a single session/workspace-level changes index. This is the biggest practical UI gap for coding or document-editing workflows.

Recommendation:

Create a Changes widget in the Evidence Rail.

Minimum useful version:

- Aggregate changed files from `edit_file`, `apply_patch`, and `write_file` tool results.
- Display status: created, modified, deleted, renamed when known.
- Display totals: file count, added lines, removed lines.
- Show latest tool source per file.
- Open full inline/sidecar diff for that file.
- Mark file viewed.
- Copy/open path using a centralized display path helper.

Later version for repo workspaces:

- Read actual git working-tree state.
- Support selected files for commit.
- Support commit only after explicit permission review.
- Push/PR actions remain out of default chat until LVIS has a dedicated repo-workflow mode.

Technical notes:

- Start from LVIS `FileEditDiff` and sidecar fetch logic.
- Add a session-level `ChangedFileIndex` in renderer state or engine event collector.
- Use 1Code's bounded diff prefetch idea only when there is a real workspace diff view.
- Do not add a git dependency before a PRD decides whether LVIS should own commit/push workflows.

Acceptance criteria:

- 30 changed files render without blocking chat.
- Large file diffs are lazy-loaded or summarized.
- File path display is stable and does not expose noisy absolute prefixes by default.
- Permission history identifies which tool made a write.

### P1 - Tool Intent Registry And Streaming Micro-states

1Code's tool rendering feels polished because it has a central mapping from raw tool parts to concise titles/subtitles and because it shows intermediate states before the tool input is complete.

LVIS already has `getToolDisplayName`, source badges, durations, and result panels. The missing layer is a richer display registry:

- `bash`: "Preparing command" while arguments stream, then command summary.
- `read_file`: short path and file size when known.
- `search`: pattern, scope, match count preview.
- `write/edit`: path, change type, plus/minus, sidecar availability.
- `mcp`: server/tool label plus rendered app availability.
- `thinking`: preview and elapsed in collapsed header.

Recommendation:

Add a `ToolDisplayRegistry` with the following contract:

```ts
type ToolDisplaySummary = {
  title: string;
  subtitle?: string;
  intent: "low" | "med" | "high" | "info" | "accent" | "neutral";
  primaryPath?: string;
  preview?: string;
  metrics?: Array<{ label: string; value: string }>;
};
```

This is a display-only layer. It must not become a second tool schema.

Technical notes:

- Keep `ToolGroupCard` as the renderer owner.
- Derive summaries from existing `ChatEntry` data.
- Add optional support for tool input streaming only if the provider event actually supplies partial input. Do not invent fake partial states.
- Centralize path shortening, ideally `formatWorkspacePath(path, workspaceRoot)`.

Acceptance criteria:

- Tool rows become understandable while collapsed.
- Long absolute paths stop dominating row width.
- Running tools can show "preparing" vs "running" vs "done" without layout shift.
- Existing compacted tool result behavior remains unchanged.

### P1 - Reasoning Header Preview

1Code auto-expands thinking while streaming. LVIS explicitly chose the opposite: reasoning starts collapsed even while streaming to prevent live thought from cluttering the conversation.

Recommendation:

Do not copy 1Code's auto-expand behavior. Instead, add a low-noise header preview:

- While streaming: spinner, "thinking...", elapsed time after 1s, optional 60-character preview.
- When complete: brain icon, "thought", preview if user has not disabled it.
- On click: existing body reveal.

This keeps LVIS's "final answer is primary" contract while making a long reasoning phase feel alive.

Acceptance criteria:

- Default collapsed state remains true.
- Preview text never pushes controls off-row.
- Sensitive/private reasoning preview can be disabled with one setting if product policy requires it.

### P1 - Plan As Reviewable Sidecar

1Code treats plan output as a first-class object in the sidebar, with readable markdown preview and approval.

LVIS has `SessionTodoPanel` and plan-like workflows, but the live checklist and the reviewable plan artifact are different things. The checklist is execution state. The plan is the contract before execution.

Recommendation:

Evidence Rail should include a Plan widget:

- Latest plan markdown.
- Plan version/time/model.
- Explicit "approved at" state.
- Diff between previous plan and revised plan when available.
- Link from relevant chat WorkGroup to the plan widget.

Acceptance criteria:

- User can approve/reject/revise a plan without searching chat history.
- Execution checklist can update independently after approval.
- Plan mode remains non-mutating until explicit approval.

### P1 - Artifact And MCP Output Workbench

LVIS already has a stronger MCP app renderer than many agent clients. The gap is discoverability across a session.

Recommendation:

Add an Artifacts widget that indexes:

- `render_html` previews.
- MCP UI resources.
- generated files/images/reports.
- last opened external resource.

Do not duplicate the renderer. Reuse `HtmlPreview`, `McpAppView`, and file preview primitives.

Acceptance criteria:

- Generated artifact remains visible after the corresponding tool card collapses.
- User can reopen the last artifact without scrolling.
- Failed artifact loads show retry and source tool.

### P2 - Integrated Terminal As Advanced Workspace Tool

1Code includes a real integrated terminal with `node-pty`/xterm and shared terminal sessions.

This is not a top-priority LVIS gap. LVIS is not a coding IDE first. However, a terminal can be useful for advanced users if it is framed as a workspace tool, not as the agent transcript.

Recommendation:

Defer a full terminal. Prefer a "Command Log" widget first:

- Shows commands run by tools.
- Shows cwd, exit code, duration, truncated stdout/stderr.
- Lets user copy command or rerun through an explicit permission path.

Only add interactive terminal after:

- permission boundaries are specified,
- shell environment ownership is clear,
- terminal lifecycle is session-scoped,
- UI has a safe stop/kill path.

### P2 - Branching, Rollback, And Worktree Views

1Code's README exposes rollback from user bubbles, chat forking, and worktree isolation.

LVIS already has session/fork-related architecture and strong governance, but a coding-agent style branch/worktree model is a larger product decision.

Recommendation:

- Keep message retry/fork as conversation features.
- Add rollback only after Changes Workbench can identify file snapshots or git commits.
- Add worktree isolation only in a dedicated repo-workflow mode, not globally.

## 5. Technical Reference Points

### 5.1 Runtime Adapter Pattern

If LVIS ever embeds Claude Code or Codex as external runtimes, copy the architectural shape, not the implementation details.

Target shape:

```ts
interface AgentRuntimeAdapter {
  id: "claude-code" | "codex-acp";
  startTurn(input: RuntimeTurnInput): AsyncIterable<LvisStreamEvent>;
  abort(turnId: string): Promise<void>;
  resume?(checkpoint: RuntimeCheckpoint): Promise<void>;
}
```

Adapter output should be LVIS's existing stream contract:

- `reasoning_delta`
- `text_delta`
- `tool_start`
- `tool_input_delta` if available
- `tool_end`
- `assistant_round`
- `done`

The adapter must map provider-native tool names into LVIS tool categories before renderer code sees them.

Do not copy:

- `allowDangerouslySkipPermissions` as a default behavior.
- mutation-based "fix common parameter mistakes" paths as internal fallback logic.
- provider-specific assumptions inside renderer components.

### 5.2 Canonical Tool Name Normalization

1Code's Codex normalizer maps provider verbs into canonical UI tool names. LVIS should use the same concept if additional runtimes are added:

| Provider/raw | LVIS display class |
| --- | --- |
| Read | read |
| Run/Bash | shell |
| List/Glob | search |
| Search/Grep | search |
| Edit/Write | write |
| Thought/Thinking | reasoning |
| Fetch/WebFetch | network |
| MCP server/tool | mcp |

This should be a display classification, not a second permission model. Permission still belongs to `GovernancePolicy` and `PermissionManager`.

### 5.3 Workspace Path Display

1Code consistently shortens project/worktree paths in bash and tool rows. LVIS should centralize this because long absolute paths currently compete with the actual operation.

Proposed helper:

```ts
formatWorkspacePath({
  path,
  workspaceRoot,
  homeDir,
  maxSegments,
  revealMode,
})
```

Rules:

- If under workspace root, show relative path.
- If under home but outside workspace, show `~/...`.
- If outside allowed roots, keep enough prefix to explain risk.
- Full path remains available via title/copy.

### 5.4 Diff Scaling

1Code's diff view uses deferred rendering and bounded prefetch for file contents. LVIS only needs this once it has a session-level or git-level diff workbench.

Recommended LVIS thresholds:

- Inline tool diff: current `FileEditDiff` behavior.
- Session Changes list: render file rows first, lazy-load diff body.
- Large diff: show summary and "load full diff".
- More than 20 files: virtualize list or paginate by status.

### 5.5 Tool Input Streaming

1Code's transformer emits tool-input-start and tool-input-delta. This enables "Generating command" and streaming thinking previews.

LVIS should add this only if provider APIs expose partial tool input. The fallback should be a simple running state, not fake streaming text.

Schema extension:

```ts
type ToolInputDeltaEvent = {
  type: "tool_input_delta";
  toolUseId: string;
  delta: string;
};
```

Renderer rule:

- While input is incomplete, show "preparing" state.
- Once input is available, show normal tool summary.
- If a turn aborts mid-input, show interrupted state tied to that tool only.

## 6. Proposed LVIS UX Direction

### 6.1 Product Principle

LVIS should not become a clone of 1Code/Cursor. LVIS should keep its current identity:

- governance-first,
- plugin/MCP aware,
- Korean enterprise workflow friendly,
- calm transcript with audit-ready work evidence,
- final assistant answer separated from internal work.

The new design direction:

> Chat is the story. Evidence Rail is the workbench. Permission is the contract.

### 6.2 Layout

Desktop:

- Left: existing navigation/sidebar.
- Center: ChatView, unchanged primary reading flow.
- Right: Evidence Rail, 320-420px default, resizable.
- Rail collapsed: 40px icon strip with badges.

Narrow desktop/tablet:

- Rail becomes overlay side sheet.
- Chat width remains readable.

Small mobile-sized window:

- Rail becomes bottom sheet with tabs.
- Only one widget open at a time.

### 6.3 Visual Style

Use existing LVIS design system:

- `info`: read-only evidence, queue, MCP/app artifacts.
- `med`: write/review-needed, plan approval, pending decisions.
- `high`: shell, destructive operations, blocked permission.
- `low`: successful read/safe completion.
- `accent`: primary action, current selected object.
- `neutral`: metadata and inactive widgets.

Avoid:

- one-note blue/purple gradient coding-agent look,
- nested floating cards,
- decorative orbs/glows,
- hero-style text in dense operational panels,
- terminal transcript as the primary UI.

### 6.4 Component Inventory

New or evolved components:

| Component | Kind | Notes |
| --- | --- | --- |
| `EvidenceRail` | organism | Owns width, collapse, active widget, responsive sheet. |
| `EvidenceWidgetHeader` | molecule | Shared compact header with icon, title, count, expand/open action. |
| `CurrentWorkWidget` | widget | Aggregates todo, sub-agent, active tool summaries. |
| `ChangesWidget` | widget | Session changed-file index and diff launcher. |
| `PlanWidget` | widget | Latest plan preview, approval status, revisions. |
| `ArtifactsWidget` | widget | HTML/MCP/file outputs. |
| `CommandLogWidget` | widget | Command history before any full terminal. |
| `ToolDisplayRegistry` | display utility | Maps tool entries into title/subtitle/intent/preview. |
| `formatWorkspacePath` | utility | Stable path display across tool, diff, permission, artifact surfaces. |

## 7. Implementation Slices

### Slice A - Display Foundation

Goal: make current transcript more legible without changing architecture.

Tasks:

- Add `formatWorkspacePath`.
- Add `ToolDisplayRegistry`.
- Add tests for path shortening and tool summary generation.
- Update `ToolGroupCard` row title/subtitle only.
- Add reasoning header elapsed/preview while preserving collapsed default.

Validation:

- Existing `ToolGroupCard` tests pass.
- Existing `ReasoningCard` tests pass or are updated to assert collapsed default.
- Long path and long command fixtures do not overflow row bounds.

### Slice B - Evidence Rail Shell

Goal: introduce the rail without changing tool execution.

Tasks:

- Add `EvidenceRail` behind a feature flag.
- Mount existing `SessionTodoPanel`/queue/sub-agent summaries as read-only widgets where possible.
- Preserve current in-flow panels until the rail proves stable.
- Add keyboard/focus and responsive behavior tests.

Validation:

- Chat remains usable with rail open/closed.
- Rail state persists per session or workspace.
- No WorkGroup rendering regression.

### Slice C - Changes Widget MVP

Goal: turn tool-level file edits into a session-level file index.

Tasks:

- Collect changed files from edit/write/apply_patch tool entries.
- Render file rows with status and plus/minus totals.
- Open existing `FileEditDiff`/sidecar diff from row.
- Track viewed/unviewed state.

Validation:

- Multiple writes to same file coalesce clearly.
- Large sidecar diff loads on demand.
- 30-file fixture is responsive.

### Slice D - Plan And Artifact Widgets

Goal: make reviewable plans and generated artifacts persistent.

Tasks:

- Index latest plan output and approval state.
- Index render_html/MCP UI/file artifacts.
- Add direct links from WorkGroup/tool rows into widget.

Validation:

- A generated artifact can be reopened after tool card collapse.
- Plan revision does not overwrite approval history without a visible state change.

### Slice E - External Runtime Adapter, Only If Needed

Goal: allow Claude Code/Codex-like runtimes without exposing their terminal UI.

Tasks:

- Define `AgentRuntimeAdapter`.
- Build one experimental adapter in a separate blueprint.
- Map provider events into LVIS stream events.
- Route all tool calls through LVIS governance.

Validation:

- Permission decisions are identical for native and adapter-originated tool calls.
- Adapter-specific tool names never leak to renderer except as metadata.
- Abort/resume/fork semantics are explicit before enabling by default.

## 8. What Not To Copy

Do not copy these 1Code patterns directly:

- Default permission bypass for non-plan mode.
- Provider-specific renderer branches spread across chat components.
- Ollama-style parameter mutation as internal fallback.
- Full integrated terminal before permission and lifecycle rules are written.
- Git commit/push/PR actions inside generic chat without a repo-workflow mode.
- Auto-expanded reasoning if it conflicts with LVIS's final-answer-first contract.
- Styling vocabulary that ignores LVIS `low/med/high/info/accent/neutral` axis.

## 9. Recommended Priority

| Priority | Item | Why |
| --- | --- | --- |
| P0 | Evidence Rail shell | Highest UX leverage; organizes existing LVIS surfaces without changing agent loop. |
| P0 | Changes Widget MVP | Biggest missing workbench capability vs 1Code; directly improves trust in code/file edits. |
| P1 | ToolDisplayRegistry + path display | Cheap polish with broad transcript readability impact. |
| P1 | Reasoning header preview | Better live feel while preserving LVIS collapsed reasoning philosophy. |
| P1 | Plan widget | Makes plan approval auditable and scroll-independent. |
| P1 | Artifact widget | Leverages existing MCP/render_html strength. |
| P2 | Command log, then terminal | Useful, but permission/lifecycle-heavy. |
| P2 | Git/worktree/rollback | Product-scope decision; depends on Changes Workbench. |
| P2 | Claude/Codex external runtime adapters | Technically interesting, but not required for LVIS's own agent UX. |

## 10. Final Recommendation

The next LVIS design blueprint should not be "integrate 1Code." It should be:

> Build a LVIS Evidence Rail that turns agent work into inspectable, persistent workspace objects while preserving the existing WorkGroup, permission, and provider-neutral loop contracts.

This gives LVIS the part of 1Code that users actually feel as polish - stable visual work state, diff confidence, plan review, artifact recall - without importing a terminal-first coding-agent product shape or weakening LVIS's governance model.
