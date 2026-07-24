# Tool Loading Policy

> Status: implementation policy for LVIS tool exposure. This document governs
> how plugin, MCP, and builtin tools move from registry to model-visible tool
> schemas. It complements `docs/architecture/architecture.md` §4.5, §6.1, §6.4,
> §9, §14 and the implementation design in
> `docs/development/tool-level-deferral-design.md`.
>
> Keyword routing was **retired** in SDK v12 (2026-07-24, lvis-plugin-sdk#229).
> `manifest.keywords` is hard-rejected at manifest load
> (`src/plugins/runtime/manifest-validation.ts`); no keyword path promotes a
> Tool, and the only callable surface is manifest `Tool` objects. Bundled
> instruction discovery belongs to `manifest.skills` and is governed by its own
> symmetric budget — see `docs/development/skill-loading-policy.md`.

## Decision

LVIS uses a **budget-based hybrid loading policy**. Plugin activation makes a
plugin's tools eligible for model exposure; the exposure mode depends on the
estimated token cost of exposing them eagerly:

- Below the eager budget: expose active plugin/MCP tool schemas eagerly. This
  avoids extra `tool_search` discovery rounds, which were measured to dominate
  TPM cost in #1176 — for a small surface, eager is *cheaper* than paying the
  per-round discovery tax.
- At or above the budget: switch to tool-level deferral. The model sees a
  compact catalog and promotes only the selected tools needed for the turn.

The budget is measured in **tokens**, not raw tool count. The MCP "Tools Tax"
(eager schema injection, ~10k–60k tokens/turn in multi-server deployments) is a
token cost, so a few very large schemas can exceed the budget while many tiny
schemas do not. `EAGER_TOOL_EXPOSURE_CEILING` (200) is retained as a cheap count
pre-filter — a hard upper bound that trips deferral without estimating — but the
authoritative gate is the estimated eager tool-schema token total against
`EAGER_TOOL_EXPOSURE_TOKEN_BUDGET` (see §7).

The canonical loading model is:

1. **Registered**: all runtime-loaded plugin tools remain in `ToolRegistry` so
   execution, permission, audit, deny rules, deprecation, auth/config/UI, and
   diagnostics use one source of truth. User-inactive plugins are not removed
   from this execution registry.
2. **Loaded eager**: when the eligible active-plugin/MCP tool count is below the
   ceiling, all in-scope active tool schemas are sent to the provider.
3. **Catalogued/deferred**: when the eligible count reaches the ceiling, active
   plugin/MCP tools not yet loaded are listed as compact `{name, description}`
   candidates in the system prompt.
4. **Loaded deferred**: in deferral mode, only builtins/meta-tools, explicitly
   promoted tools (via `tool_search`), and current-scope carried-forward tools
   are sent as full `tools[]` schemas to the provider.

User-inactive plugins are excluded from provider `tools[]`, `<tool-catalog>`,
and `request_plugin`, but stay runtime-callable through host/UI execution paths.

This is a budget contract, not a capability restriction. Deferring schema
exposure must never remove a tool from the registry or bypass permission checks.

## Reference Basis

- OpenAI tool search guidance recommends deferring tool definitions and loading
  only the definitions needed at runtime. It also notes that deferring a single
  function mostly saves parameter-schema tokens, while deferring larger logical
  namespaces saves more because function names and descriptions need not be
  repeated upfront.
  - `https://developers.openai.com/api/docs/guides/tools-tool-search`
- OpenAI function-calling guidance describes the multi-step loop: provide tools,
  receive tool calls, execute them, then send results back for another model
  response. Any oversized tool schema set is therefore paid repeatedly across
  tool-use rounds, not once per user turn.
  - `https://developers.openai.com/api/docs/guides/function-calling`
- Prompt caching can reduce repeated-prefix cost/latency, but it is not a
  substitute for a small tool surface. Cache eligibility depends on stable
  prefixes and does not make large `tools[]` payloads safe under TPM pressure.
  - `https://developers.openai.com/api/docs/guides/prompt-caching`
- Anthropic Agent Skills establish **progressive disclosure** as the discovery
  pattern: at startup only each skill's name + description load (a few dozen
  tokens each); the full `SKILL.md` body loads only when a task matches, and
  bundled resources load on demand. The always-present metadata is a fixed cost,
  so it must be bounded — the same discipline this policy applies to tools is
  applied to skills in `docs/development/skill-loading-policy.md`.
  - `https://www.anthropic.com/news/skills`, `https://agentskills.io`
- Dynamic-toolset / "Tools Tax" reports converge on the same conclusion the
  local #1176 evidence reached: eager schema injection is a per-turn *token*
  overhead (~10k–60k tokens in multi-server MCP deployments), paid on every
  round, and just-in-time discovery keeps that cost roughly constant as a
  catalog scales from tens to hundreds of tools. Semantic (embedding) tool
  search reports ~97% hit-rate at K=3; LVIS uses lexical scoring instead
  (cross-vendor, no embedding infrastructure) — embeddings remain future work.

## Local Evidence

The 2026-05-24 investigation originally suspected whole active-plugin schema
loading, but #1176 reversed that premise with measured data. Making deferral
unconditional caused the indexer workflow to spend many additional rounds on
`tool_search`, re-sending the same conversation prefix until it hit the 200K TPM
limit. The eager path for the same active plugin surface finished in far fewer
rounds and avoided the TPM spike.

Current plugin manifest sizes explain why the common case should stay eager and
why a high ceiling is still needed for future large surfaces:

| Plugin | Tools |
| --- | ---: |
| `agent-hub` | 43 |
| `ms-graph` | 30 |
| `meeting` | 29 |
| `ep` | 29 |
| `local-indexer` | 19 |

## Policy

### 1. Registry Is Not Exposure

All installed tools may be registered, but registration must not imply provider
visibility. The registry is the authority for execution-time lookup and policy;
the provider request is a selected view.

Required invariant:

```text
registered_tools >= (loaded_schema_tools + catalog_tools)
```

The provider-visible view must come from the registry. In eager mode,
`catalog_tools` is normally empty and `loaded_schema_tools` contains the active
tool surface below the ceiling. In deferred mode, `loaded_schema_tools` is the
selected subset and `catalog_tools` carries compact discovery hints.

### 2. Plugin Activation Means Catalog Scope

`request_plugin` activates a plugin into the current scope. After activation the
loop recomputes the eligible active-plugin/MCP tool count:

- If the count remains below the ceiling, the activation result should say the
  plugin tools are loaded and can be called directly.
- If the count reaches the ceiling, the activation result should say the plugin
  tools are discoverable through `tool_search`.

### 3. Loaded Schemas Are Selected Tools

Tools may enter `tools[]` only through one of these paths:

- Builtin/meta tools required for the loop, such as `request_plugin` and
  `tool_search`.
- Eager full-schema exposure for all active plugin/MCP tools when the eager
  token budget (and the count pre-filter) is not exceeded.
- `tool_search` promotion from the current compact catalog.
- Carry-forward from the previous turn, clamped to the current active plugin/MCP
  scope.
- Explicit sub-agent/routine/headless allowlists.

No path may promote a tool whose owner is outside current scope or blocked by
deny rules.

### 4. Not Always One Tool

When deferral is active, the target is not "exactly one plugin tool" in every
turn. One tool is the preferred floor for narrow requests, but real workflows
often need a small set of related tools. The deferred-mode policy is **small
selected subset**, not whole plugin.

Default promotion should be conservative:

- exact tool-name match: load the matching tool
- broad/natural-language query: score candidates and load only the top few
- explicit multi-tool intent: load a small group if the group is justified

When a plugin has large functional areas, prefer a logical namespace/group
smaller than the plugin. Keep groups below 10 tools where practical.

### 5. Catalog Matching Must Be Bounded

Catalog matching must not use unbounded "any token substring" promotion. Broad
queries such as "list", "get", "work", or one-character tokens can promote many
tools and erase the token-floor benefit.

Required behavior in deferred mode:

- ignore very short query tokens
- score exact name, prefix, keyword, and description matches separately
- cap promoted tools per `tool_search` call
- cap total promoted tools per turn/session
- emit metrics for loaded/deferred counts and promoted names

### 6. Projection And TPM Are Part Of The Contract

Before a request is sent, request-input projection must include the same
`tools[]` schemas that will be sent to the provider. The projection should
record:

- system prompt tokens
- provider-wire message tokens
- tool schema tokens
- loaded tool count
- deferred catalog count
- model TPM threshold source, if known

TPM protection must not rely on auto-compact alone. Compacting history does not
shrink the active tool schema set.

### 7. Budget-Based Deferral Gate

There is no `experimental.toolDeferral` runtime flag. Deferral trips when
**either** bound is exceeded:

```text
eligibleActivePluginAndMcpToolCount  >= EAGER_TOOL_EXPOSURE_CEILING       // cheap count pre-filter
OR estimatedEagerToolSchemaTokens    >= EAGER_TOOL_EXPOSURE_TOKEN_BUDGET   // authoritative token gate
```

The token estimate sums a per-tool schema-token estimate over the eligible eager
set (the same schemas §6 projection records). The count pre-filter is a hard
upper bound so a pathological catalog can never be exposed eagerly even when
token estimation is unavailable; the token gate is what actually protects TPM,
because a few large schemas cost more than many small ones. Both are pure
functions of the eligible set — no runtime flag, no settings branch.

Required invariants:

- `request_plugin` to `tool_search` same-turn flow is covered by integration
  tests.
- Catalog and loaded-tool state remain coherent across rounds.
- Sub-agent, routine, and headless paths have explicit tool availability tests.
- Catalog matching uses bounded scoring/top-N instead of broad substring
  promotion.
- Carry-forward tools are clamped when a plugin leaves scope.
- Audit/trace metrics expose deferred-vs-loaded ratios and the token estimate
  that drove the decision, alongside the count.

Keeping a settings-based alternate path would violate the no-fallback-code rule.
The eager and deferred modes are not legacy fallbacks; they are both branches of
the single budget-based policy.

## Implementation Direction

 Tool discovery is `tool_search` promotion of individual tools or small tool
 subsets from the compact catalog. There is no keyword preload path (retired in
 SDK v12); bundled instruction discovery belongs to `manifest.skills`
 (`docs/development/skill-loading-policy.md`).

Do not switch the app to OpenAI-only hosted tool search as the first fix. LVIS
routes tool schemas through the cross-vendor Vercel AI SDK provider adapter, so
the stable implementation surface is client-side schema deferral in
`ToolRegistry`, `ConversationLoop`, and `SystemPromptBuilder`.

The long-term model should add manifest-level grouping, for example:

```json
{
  "toolGroups": [
    {
      "id": "agent-hub.work-items",
      "description": "Create, list, update, and inspect Agent Hub work items.",
      "tools": ["agent_hub_create_work_item", "agent_hub_list_work_items"]
    }
  ]
}
```

Groups should improve discovery and preload precision. They must not become a
new way to load an entire large plugin.
