# Tool Loading Policy

> Status: implementation policy for LVIS tool exposure. This document governs
> how plugin, MCP, and builtin tools move from registry to model-visible tool
> schemas. It complements `docs/architecture/architecture.md` §4.5, §6.1, §6.4,
> §9, §14 and the implementation design in
> `docs/development/tool-level-deferral-design.md`.
>
> The keyword path below is deprecated keyword-to-Tool-schema preload, despite
> the legacy internal name `SkillKeyword.skillId`. It is separate from bundled
> `manifest.skills` instruction discovery and never invokes a Tool. Owner:
> `lvis-app` plugin runtime. Remove it after every supported plugin has migrated
> to bundled `manifest.skills` and no active manifest declares `keywords`.

## Decision

LVIS uses a count-based hybrid loading policy. Plugin activation makes a
plugin's tools eligible for model exposure, but the exposure mode depends on the
eligible tool count:

- Below `EAGER_TOOL_EXPOSURE_CEILING` (`200`): expose active plugin/MCP tool
  schemas eagerly. This avoids extra `tool_search` discovery rounds, which were
  measured to dominate TPM cost in #1176.
- At or above the ceiling: switch to tool-level deferral. The model sees a
  compact catalog and promotes only the selected tools needed for the turn.

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
4. **Loaded deferred**: in deferral mode, only builtins/meta-tools,
   keyword-preloaded tools, explicitly promoted tools, and current-scope
   carried-forward tools are sent as full `tools[]` schemas to the provider.

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
- Eager full-schema exposure for all active plugin/MCP tools when
  `eligibleCount < EAGER_TOOL_EXPOSURE_CEILING`.
- Deprecated Tool-schema preloading from the legacy-named
  `SkillKeyword.skillId` when the owning plugin is in scope and deferral is
  active.
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
- strong keyword match: load the Tool schema named by the legacy `skillId`
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

### 7. Count-Based Deferral Gate

There is no `experimental.toolDeferral` runtime flag. The single gate is:

```text
eligibleActivePluginAndMcpToolCount >= EAGER_TOOL_EXPOSURE_CEILING
```

Required invariants:

- `request_plugin` to `tool_search` same-turn flow is covered by integration
  tests.
- Catalog and loaded-tool state remain coherent across rounds.
- Sub-agent, routine, and headless paths have explicit tool availability tests.
- Catalog matching uses bounded scoring/top-N instead of broad substring
  promotion.
- Carry-forward tools are clamped when a plugin leaves scope.
- Audit/trace metrics expose deferred-vs-loaded ratios.

Keeping a settings-based alternate path would violate the no-fallback-code rule.
The eager and deferred modes are not legacy fallbacks; they are both branches of
the single count-based policy.

## Implementation Direction

The current implementation uses deprecated host-side keyword-to-Tool-schema
preload plus `tool_search` to promote individual tools or small tool subsets.
Do not expand the keyword surface; bundled instruction discovery belongs to
`manifest.skills`.

Do not switch the app to OpenAI-only hosted tool search as the first fix. LVIS
currently routes tool schemas through the cross-vendor Vercel AI SDK provider
adapter, so the stable implementation surface is client-side schema deferral in
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
