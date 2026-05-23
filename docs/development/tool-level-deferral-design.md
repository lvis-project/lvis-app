# Tool-Level Deferral (hybrid keyword-preload + `tool_search`)

> Status: Phase 1 design (host-only). Rooted in `docs/architecture/architecture.md` §6.4 (Tool Registry),
> §6.1 (KeywordEngine), §4.5 (Conversation Query Loop). Companion to the existing plugin-level lazy
> scoping (`request_plugin`).

## Problem

Per-request token floor is dominated by tool-schema injection. Measured (trace `fb7300de`, failed turn T14,
2026-05-24): plugin-level scoping worked (2 of 6 plugins active) but each *active plugin loads ALL its tools* —
0 plugins → 23 tools, 1 (ms-graph) → 53, 2 (+local-indexer) → 72. Those 72 tool schemas were re-sent on every
one of 8 loop rounds, blowing past gpt-5.4-mini's 200K TPM → `stream-error`.

Reference CLIs (Claude Code, Codex) keep the floor low with **tool-level** deferral (`tool_search`), not
all-or-nothing plugin activation. LVIS already has the *plugin-level* mechanism; this adds the *tool-level* layer.

## Design (hybrid B + A)

Two cooperating mechanisms, both **host-only** (no plugin-repo manifest change required for Phase 1):

- **(B) Keyword→tool preload** — reuse the existing `SkillKeyword.skillId`. When `matchAllPluginIds` matches a
  plugin, the *same* matched keywords already carry a `skillId` that resolves (via `toolRegistry.findByName`) to a
  specific tool. Preload only those tools' full schemas. No round-trip.
- **(A) `tool_search` meta-tool** — for everything not preloaded, the model sees a compact **catalog** (name +
  1-line description, no JSON schema). Calling `tool_search({ query })` promotes matching tools into the live
  `tools[]` for the next round. Mirrors `request_plugin` exactly.

Gated by a **feature flag** (`settings.experimental.toolDeferral`, default **off**). Flag off ⇒ byte-for-byte
current behavior (no catalog, no `tool_search` tool, active plugin loads all tools). Flag on ⇒ the model below.
Architecture §14 sanctions feature flags; this is staged rollout, not a fallback shim.

### Tool visibility states (flag on)

| State | In `tools[]` (full schema)? | In system prompt? |
|---|---|---|
| **Loaded** | yes | full name+desc (`<available-tools>`) |
| **Catalog** | no | name + 1-line (`<tool-catalog>`, "call tool_search to load") |
| **Hidden** | no | no (denied, or plugin fully inactive → still reachable via `request_plugin`) |

- **Loaded** = builtins + meta-tools (always) + keyword-preloaded tools (B) + `tool_search`/`request_plugin`-promoted tools.
- **Catalog** = all visible plugin/MCP tools that are in scope but not loaded.

## Data model changes

`ConversationLoop.ToolScope` (conversation-loop.ts:512) gains:

```ts
interface ToolScope {
  activePluginIds: Set<string>;
  activeToolNames: Set<string>;   // NEW — individually-promoted/preloaded plugin+mcp tools
  includeBuiltins: boolean;
  includeMcp: boolean;
  deferral: boolean;              // NEW — feature flag snapshot for this turn
}
```

`ToolRegistry.getToolSchemasForScope` (registry.ts:290) — plugin/MCP branch becomes:

```
plugin/mcp tool included as LOADED iff:
  scope.deferral
    ? scope.activeToolNames.has(tool.name)
    : (plugin: scope.activePluginIds.has(tool.pluginId); mcp: scope.includeMcp)   // unchanged legacy path
```

New `ToolRegistry.getToolCatalogForScope(scope)` → `{ name, description }[]` of visible plugin/MCP tools that are
**in scope** (plugin active OR mcp included) but **not** in `activeToolNames`. Description trimmed to first
sentence / ~100 chars for the catalog. Deny rules (`getVisibleTools`) apply first, same as the loaded path.

## File-by-file (Phase 1, host-only)

1. **`src/engine/conversation-loop.ts`**
   - Extend `ToolScope` (line 512).
   - `resolveToolScope` (line 2735): read flag from settings; compute `activeToolNames` =
     `keywordEngine.matchToolNames(input)` (B) ∪ carried `lastTurnScope.activeToolNames`. Keep `activePluginIds`
     as today (drives catalog membership + legacy path). When flag off, `activeToolNames` unused.
   - `lastTurnScope` (line 1577): persist `activeToolNames` too (so a follow-up keeps loaded tools).
   - Wire `handleToolSearch` next to `handleRequestPlugin` (lines 2248-2288): same intercept→promote→
     `rebuildToolSchemas(scope)` pattern, sharing the round-refund (`round--`) and counter logic.
2. **`src/core/keyword-engine.ts`**: add `matchToolNames(input): Set<string>` — scan `skillKeywords`, return
   `skillId`s whose keyword appears in input AND that resolve to a registered plugin/mcp tool. (Companion to
   `matchAllPluginIds`; reuses the same registration data, no new manifest field.)
3. **`src/tools/registry.ts`**: `getToolSchemasForScope` tool-level branch (flag-gated) + new
   `getToolCatalogForScope`.
4. **`src/engine/turn/tool-search.ts`** (NEW, mirror `plugin-expansion.ts`): `handleToolSearch(toolUses, state)` —
   intercept `tool_search`, match catalog tools by query (name/description substring + keyword), add to
   `activeToolNames`, return synthesized `tool_result` + `promotedToolNames`. Caps: `MAX_TOOL_SEARCH_PER_TURN`,
   `MAX_TOOL_SEARCH_PER_SESSION` (mirror the request_plugin caps; pick generous values, e.g. 4 / 20, since this is
   the primary discovery path).
5. **`src/boot/tools.ts`**: register the `tool_search` builtin meta-tool (schema `{ query: string }`) alongside
   `request_plugin`, only when the flag is on. It is intercepted before the executor (like `request_plugin`), so
   its "handler" never actually runs — but register a schema so the LLM can call it.
6. **`src/prompts/system-prompt-builder.ts`**: Source 5 renders **loaded** tools only (already scope-driven). Add
   a new source "Tool Catalog" (per-turn, flag-gated) rendering `getToolCatalogForScope` as
   `<tool-catalog> … call tool_search({query}) to load … </tool-catalog>`. Source 65 (inactive *plugin* catalog)
   stays for the `request_plugin` path.

## Invariants preserved (must not regress)

- **Permission/audit/sandbox** run at *execution* time keyed on the registered `Tool` object (registry is never
  pruned — only the *schema array sent to the LLM* is filtered). Deferring a schema cannot bypass a permission
  gate. (Confirmed: permission-manager.ts checks at exec, reads `Tool.pluginId` from registry.)
- **Deny rules (§6.3 Layer 1)** apply to catalog + loaded alike (`getVisibleTools()` first).
- **Tool-pair invariant** (`repairToolPairInvariant`): `tool_search` synthesizes a matching `tool_result` for
  every intercepted `tool_use`, exactly like `request_plugin`.
- **Flag off** ⇒ no behavioral change at all (legacy path untouched).
- **No Fallback Code**: the legacy (flag-off) branch is the staged-rollout default with a removal plan
  (Phase 3: flip default on, then delete the legacy branch), not an indefinite compat shim.

## Tests (Phase 1)

- `keyword-engine.test`: `matchToolNames` returns skillIds resolving to tools; ignores unmatched/unresolvable.
- `registry.test`: `getToolSchemasForScope` tool-level filtering (flag on) vs plugin-level (flag off);
  `getToolCatalogForScope` excludes loaded + denied tools.
- `tool-search.test` (mirror `request_plugin.test`): intercept, promote, caps, unknown-query error, tool-pair
  result synthesis, round refund.
- `conversation-loop` integration: flag on → turn-1 `tools[]` = builtins + preloaded only; after `tool_search`,
  next round includes promoted tool; flag off → unchanged.
- `system-prompt-builder.test`: catalog section present (flag on) / absent (flag off); loaded tools not duplicated
  in catalog.

## Phasing

- **Phase 1 (this PR, host-only)**: everything above, flag default **off**. Lands the full mechanism + tests with
  zero production behavior change.
- **Phase 2 (cross-repo, optional)**: richer manifest `keywords[].tools?: string[]` (multiple preload tools per
  keyword, not just `skillId`) in SDK schema + all plugin repos + template + marketplace validation. Field-Addition
  Sweep + companion PRs.
- **Phase 3**: enable flag by default after e2e/dogfood, then remove the legacy branch.
