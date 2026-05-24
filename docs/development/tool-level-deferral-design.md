# Tool-Level Deferral (hybrid keyword-preload + `tool_search`)

> Status: host-only implementation direction, default-on. Rooted in `docs/architecture/architecture.md` §6.4 (Tool Registry),
> §6.1 (KeywordEngine), §4.5 (Conversation Query Loop). Companion to the existing plugin-level lazy
> scoping (`request_plugin`). Loading policy lives in
> `docs/development/tool-loading-policy.md`.

## Problem

Per-request token floor is dominated by tool-schema injection. Measured (trace `fb7300de`, failed turn T14,
2026-05-24): plugin-level scoping worked (2 of 6 plugins active) but each *active plugin loads ALL its tools* —
0 plugins → 23 tools, 1 (ms-graph) → 53, 2 (+local-indexer) → 72. Those 72 tool schemas were re-sent on every
one of 8 loop rounds, blowing past gpt-5.4-mini's 200K TPM → `stream-error`.

Reference CLIs (Claude Code, Codex) keep the floor low with **tool-level** deferral (`tool_search`), not
all-or-nothing plugin activation. LVIS already has the *plugin-level* mechanism; this adds the *tool-level* layer.
The policy decision is not "load exactly one plugin tool"; it is "load the smallest selected tool set that can
handle the current turn." Narrow turns should often load one plugin tool, while explicit multi-step workflows may
load a small related subset. Whole-plugin schema loading is not the target state for large plugins.

## Design (hybrid B + A)

Two cooperating mechanisms, both **host-only** (no plugin-repo manifest change required at this stage):

- **(B) Keyword→tool preload** — reuse the existing `SkillKeyword.skillId`. When `matchAllPluginIds` matches a
  plugin, the *same* matched keywords already carry a `skillId` that resolves (via `toolRegistry.findByName`) to a
  specific tool. Preload only those tools' full schemas. No round-trip.
- **(A) `tool_search` meta-tool** — for everything not preloaded, the model sees a compact **catalog** (name +
  1-line description, no JSON schema). Calling `tool_search({ query })` promotes matching tools into the live
  `tools[]` for the next round. Mirrors `request_plugin` exactly.

`settings.experimental.toolDeferral` remains in the settings shape for migration/readability, but the runtime no
longer branches back to whole-plugin schema loading. Tool-level deferral is the default and only plugin/MCP
schema exposure path.

### Tool visibility states

| State | In `tools[]` (full schema)? | In system prompt? |
|---|---|---|
| **Loaded** | yes | full name+desc (`<available-tools>`) |
| **Catalog** | no | name + 1-line (`<tool-catalog>`, "call tool_search to load") |
| **Hidden** | no | no (denied, or plugin fully inactive → still reachable via `request_plugin`) |

- **Loaded** = builtins + meta-tools (always) + keyword-preloaded tools (B) + `tool_search`-promoted tools.
- **Catalog** = all visible plugin/MCP tools that are in scope but not loaded.
- `request_plugin` promotes a plugin into catalog scope. In deferral mode it must not promote every tool schema
  owned by that plugin.

## Data model changes

`ConversationLoop.ToolScope` (conversation-loop.ts:512) gains:

```ts
interface ToolScope {
  activePluginIds: Set<string>;
  activeToolNames: Set<string>;   // NEW — individually-promoted/preloaded plugin+mcp tools
  includeBuiltins: boolean;
  includeMcp: boolean;
  deferral: boolean;              // retained compatibility marker; runtime path is default-on
}
```

`ToolRegistry.getToolSchemasForScope` (registry.ts:290) — plugin/MCP branch becomes:

```
plugin/mcp tool included as LOADED iff:
  scope.activeToolNames.has(tool.name)
```

New `ToolRegistry.getToolCatalogForScope(scope)` → `{ name, description }[]` of visible plugin/MCP tools that are
**in scope** (plugin active OR mcp included) but **not** in `activeToolNames`. Description trimmed to first
sentence / ~100 chars for the catalog. Deny rules (`getVisibleTools`) apply first, same as the loaded path.

## File-by-file (host-only stage)

1. **`src/engine/conversation-loop.ts`**
   - Extend `ToolScope` (line 512).
   - `resolveToolScope` (line 2735): compute `activeToolNames` =
     `keywordEngine.matchToolNames(input)` (B) ∪ carried `lastTurnScope.activeToolNames` ∪ explicit fixed-surface
     allowlists. Keep `activePluginIds` as catalog membership, not whole-plugin schema loading.
   - `lastTurnScope` (line 1577): persist `activeToolNames` too (so a follow-up keeps loaded tools).
   - Wire `handleToolSearch` next to `handleRequestPlugin` (lines 2248-2288): same intercept→promote→
     `rebuildToolSchemas(scope)` pattern, sharing the round-refund (`round--`) and counter logic.
2. **`src/core/keyword-engine.ts`**: add `matchToolNames(input): Set<string>` — scan `skillKeywords`, return
   `skillId`s whose keyword appears in input AND that resolve to a registered plugin/mcp tool. (Companion to
   `matchAllPluginIds`; reuses the same registration data, no new manifest field.)
3. **`src/tools/registry.ts`**: `getToolSchemasForScope` tool-level filtering + `getToolCatalogForScope`.
4. **`src/engine/turn/tool-search.ts`** (NEW, mirror `plugin-expansion.ts`): `handleToolSearch(toolUses, state)` —
   intercept `tool_search`, score catalog tools by query (exact name / prefix / keyword / description), add only the
   bounded top matches to `activeToolNames`, return synthesized `tool_result` + `promotedToolNames`. Caps:
   `MAX_TOOL_SEARCH_PER_TURN`, `MAX_TOOL_SEARCH_PER_SESSION`, and a per-search promotion cap prevent broad queries
   from erasing the token-floor benefit.
5. **`src/boot/tools.ts`**: register the `tool_search` builtin meta-tool (schema `{ query: string }`) alongside
   `request_plugin`. It is intercepted before the executor (like `request_plugin`), so
   its "handler" never actually runs — but register a schema so the LLM can call it.
6. **`src/prompts/system-prompt-builder.ts`**: Source 5 renders **loaded** tools only (already scope-driven). Add
   a new source "Tool Catalog" (per-turn) rendering `getToolCatalogForScope` as
   `<tool-catalog> … call tool_search({query}) to load … </tool-catalog>`. Source 65 (inactive *plugin* catalog)
   stays for the `request_plugin` path.

## Invariants preserved (must not regress)

- **Permission/audit/sandbox** run at *execution* time keyed on the registered `Tool` object (registry is never
  pruned — only the *schema array sent to the LLM* is filtered). Deferring a schema cannot bypass a permission
  gate. (Confirmed: permission-manager.ts checks at exec, reads `Tool.pluginId` from registry.)
- **Deny rules (§6.3 Layer 1)** apply to catalog + loaded alike (`getVisibleTools()` first).
- **Tool-pair invariant** (`repairToolPairInvariant`): `tool_search` synthesizes a matching `tool_result` for
  every intercepted `tool_use`, exactly like `request_plugin`.
- **No Fallback Code**: the legacy whole-plugin branch is removed after the default-on cutover. Persisted
  `experimental.toolDeferral=false` does not restore broad schema loading.
- **Budget contract**: request-input projection must include the same `tools[]` schemas that the provider request
  receives, and traces must expose loaded/deferred tool counts before default-on.

## Tests (host-only stage)

- `keyword-engine.test`: `matchToolNames` returns skillIds resolving to tools; ignores unmatched/unresolvable.
- `registry.test`: `getToolSchemasForScope` tool-level filtering;
  `getToolCatalogForScope` excludes loaded + denied tools.
- `tool-search.test` (mirror `request_plugin.test`): intercept, promote, caps, unknown-query error, tool-pair
  result synthesis, round refund, and broad-query top-N clamping.
- `conversation-loop` integration: turn-1 `tools[]` = builtins + preloaded only; after `tool_search`,
  next round includes promoted tool; persisted flag false does not restore the legacy path.
- `system-prompt-builder.test`: catalog section present when deferred tools exist; loaded tools not duplicated
  in catalog.
- Sub-agent/routine/headless integration: deferral on never leaves an explicitly allowed tool unavailable to the
  child/headless loop.
- Observability tests or snapshot assertions: traces/audit include loaded tool count, deferred catalog count, and
  promoted tool names.

## Phasing

- **Host-only stage**: landed the mechanism behind the settings field with tests.
- **Cross-repo follow-up (optional)**: richer manifest `keywords[].tools?: string[]` (multiple preload tools per
  keyword, not just `skillId`) or manifest `toolGroups[]` for small logical namespaces in SDK schema + all plugin
  repos + template + marketplace validation. Field-Addition Sweep + companion PRs.
- **Default-on cutover**: enable by default and remove the legacy branch.
