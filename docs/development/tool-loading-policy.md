# Tool Loading Policy

> Status: implementation policy for LVIS tool exposure. This document governs
> how plugin, MCP, and builtin tools move from registry to model-visible tool
> schemas. It complements `docs/architecture/architecture.md` §4.5, §6.1, §6.4,
> §9, §14 and the implementation design in
> `docs/development/tool-level-deferral-design.md`.

## Decision

LVIS must not treat plugin activation as permission to send every tool schema
owned by that plugin to the model. Plugin activation makes a plugin's tools
eligible for discovery. Full JSON schema exposure is a narrower state: only
tools selected for the current turn, or a small selected subset, may enter the
provider request's `tools[]` array.

The canonical loading model is:

1. **Registered**: all installed, policy-visible tools remain in `ToolRegistry`
   so execution, permission, audit, deny rules, deprecation, and diagnostics use
   one source of truth.
2. **Catalogued**: active plugin/MCP tools that are relevant but not loaded are
   listed as compact `{name, description}` candidates in the system prompt.
3. **Loaded**: only builtins/meta-tools, keyword-preloaded tools, explicitly
   promoted tools, and current-scope carried-forward tools are sent as full
   `tools[]` schemas to the provider.

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

The 2026-05-24 TPM incident showed that plugin-level scoping was insufficient.
Trace `fb7300de` activated only a subset of plugins, but each active plugin
still loaded every owned tool. The observed tool surface grew from 52 tools to
95 after `agent-hub`, then to 114 after `local-indexer`; a follow-up model round
hit the provider TPM limit. The tool results near the failure were small, so the
dominant payload was tool schema exposure plus repeated loop rounds.

Current plugin manifest sizes make whole-plugin schema loading structurally
unsafe:

| Plugin | Tools |
| --- | ---: |
| `agent-hub` | 43 |
| `ms-graph` | 30 |
| `meeting` | 29 |
| `lge-api` | 29 |
| `local-indexer` | 19 |

## Policy

### 1. Registry Is Not Exposure

All installed tools may be registered, but registration must not imply provider
visibility. The registry is the authority for execution-time lookup and policy;
the provider request is a selected view.

Required invariant:

```text
registered_tools >= visible_catalog_tools >= loaded_schema_tools
```

`loaded_schema_tools` must be the smallest set that can reasonably satisfy the
current turn.

### 2. Plugin Activation Means Catalog Scope

`request_plugin` activates a plugin into the current discovery scope. In
tool-deferral mode it must not load all plugin-owned schemas. It should make the
plugin's tools available through the compact catalog and allow subsequent
keyword preload or `tool_search` promotion.

The user-facing activation result should say "tools are discoverable" or "tools
are available through tool search" instead of reporting "0 tools added" when
schemas were intentionally deferred.

### 3. Loaded Schemas Are Selected Tools

Tools may enter `tools[]` only through one of these paths:

- Builtin/meta tools required for the loop, such as `request_plugin` and
  `tool_search`.
- Keyword preloading from `SkillKeyword.skillId` when the owning plugin is in
  scope.
- `tool_search` promotion from the current compact catalog.
- Carry-forward from the previous turn, clamped to the current active plugin/MCP
  scope.
- Explicit sub-agent/routine/headless allowlists.

No path may promote a tool whose owner is outside current scope or blocked by
deny rules.

### 4. Not Always One Tool

The target is not "exactly one plugin tool" in every turn. One tool is the
preferred floor for narrow requests, but real workflows often need a small set
of related tools. The policy is **small selected subset**, not whole plugin.

Default promotion should be conservative:

- exact tool-name match: load the matching tool
- strong keyword match: load the matching `skillId` tool
- broad/natural-language query: score candidates and load only the top few
- explicit multi-tool intent: load a small group if the group is justified

When a plugin has large functional areas, prefer a logical namespace/group
smaller than the plugin. Keep groups below 10 tools where practical.

### 5. Catalog Matching Must Be Bounded

Catalog matching must not use unbounded "any token substring" promotion. Broad
queries such as "list", "get", "work", or one-character tokens can promote many
tools and erase the token-floor benefit.

Required behavior before default-on:

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

### 7. Default-On Gate

`experimental.toolDeferral` is default-on only when these gates pass:

- `request_plugin` to `tool_search` same-turn flow is covered by integration
  tests.
- Catalog and loaded-tool state remain coherent across rounds.
- Sub-agent, routine, and headless paths have explicit tool availability tests.
- Catalog matching uses bounded scoring/top-N instead of broad substring
  promotion.
- Carry-forward tools are clamped when a plugin leaves scope.
- Audit/trace metrics expose deferred-vs-loaded ratios.
- The legacy whole-plugin loading branch is removed from the runtime path.

Keeping both paths indefinitely violates the no-fallback-code rule.

## Implementation Direction

The current direction in `tool-level-deferral-design.md` is correct: use
host-side keyword preload plus `tool_search` to promote individual tools or
small tool subsets. The next implementation should harden that design rather
than replace it with native-provider-specific hosted tool search.

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
