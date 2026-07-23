# Tool-Level Deferral (hybrid keyword-preload + `tool_search`)

> Status: host-only implementation direction. Rooted in `docs/architecture/architecture.md` §6.4 (Tool Registry),
> §6.1 (KeywordEngine), §4.5 (Conversation Query Loop). Companion to the existing plugin-level lazy
> scoping (`request_plugin`). Loading policy lives in
> `docs/development/tool-loading-policy.md`.

## Update (#1176) — eager exposure restored; deferral is now a HIGH-threshold gate

The original premise below ("whole-plugin schema loading is the TPM failure mode") was **reversed by
measured data**. After deferral was made unconditional (`d4d6fa8d`), the per-tool `tool_search` discovery
tax — not the schema size — became the dominant cost: a document-indexer turn went from ~6 rounds (eager)
to ~21 rounds (~12 of them spent on `tool_search` discovery), re-sending full context each round until it
blew the 200K TPM ceiling (429). Eager exposure of an active plugin's whole suite completed the same turn in
~6 rounds without a 429.

**New SOT (this document's governing policy):**

- **Active plugins' full tool suites are exposed eagerly** by default. There is no per-tool discovery tax for
  the common case.
- **Deferral is gated behind a HIGH threshold**: `eligibleCount >= EAGER_TOOL_EXPOSURE_CEILING` (`200`, defined
  in `src/shared/tool-exposure-policy.ts`). *Eligible* counts only active-plugin + in-scope MCP tools; **builtins
  and meta-tools are always eager and never counted**. Below the ceiling → eager full-schema exposure, empty
  catalog, zero `tool_search`. At/above it → the per-tool deferral mechanism described below.
- **Plugin active/inactive state** is managed via two cooperating layers (NOT a single mechanism):
  1. **`PluginRuntime.inactivePluginIds`** (in-memory Set, SOT): populated at boot from `PluginRegistryEntry.enabled === false` and toggled at runtime by `setPluginEnabled()`. `isPluginEnabled(id)` reads this Set — never the persisted registry field — so the per-turn scope gate is always correct after a restart.
  2. **Execution registry vs model exposure** (`boot/plugins.ts`, `boot/steps/plugin-runtime.ts`): ToolRegistry keeps runtime-loaded plugin tools registered for execution, auth/config/UI, permission, and audit. ConversationLoop scope filters inactive plugins out of provider `tools[]`, `<tool-catalog>`, and `request_plugin`. Runtime `setPluginEnabled(false)` fires `onActiveStateChange(false)` to remove keywords and transient turn scope only; it does **not** unload the plugin or unregister ToolRegistry entries. `setPluginEnabled(true)` fires `onActiveStateChange(true)` to re-register manifest keywords when needed.

  Together: inactive plugin stays fully loaded in memory (no stop/reload churn), its tools remain executable through host/UI paths, and its keywords/tools are absent from model-visible prompt scope. This is the deliberate TPM lever — disable a heavy plugin to shrink the turn's tool surface while preserving config/auth UX.
- The **"do not reintroduce full-schema loading" directive is retired.** Full-schema loading *is* the default
  again below the ceiling. The dead `settings.experimental.toolDeferral` flag (never read at runtime after the
  unconditional cutover) was removed — there is no settings branch; the count-based gate is the only switch.

The mechanism below (keyword preload + `tool_search` catalog) is unchanged and still applies **only** when the
eligible count reaches the ceiling.

## Problem

Per-request token floor is dominated by tool-schema injection. Measured (trace `fb7300de`, failed turn T14,
2026-05-24): plugin-level scoping worked (2 of 6 plugins active) but each *active plugin loads ALL its tools* —
0 plugins → 23 tools, 1 (ms-graph) → 53, 2 (+local-indexer) → 72. Those 72 tool schemas were re-sent on every
one of 8 loop rounds, blowing past gpt-5.4-mini's 200K TPM → `stream-error`.

Reference CLIs (Claude Code, Codex) keep the floor low with **tool-level** deferral (`tool_search`), not
all-or-nothing plugin activation. LVIS already has the *plugin-level* mechanism; this adds the *tool-level* layer.
The policy decision (as revised by #1176, above) is: expose active plugins' full tool suites eagerly until the
eligible-tool count reaches `EAGER_TOOL_EXPOSURE_CEILING`, then fall back to the smallest selected tool set that
can handle the current turn. Whole-plugin schema loading **is** the target state below the ceiling — it is the
genuinely large tool surface (≥200 eligible) that warrants per-tool deferral.

## Design (hybrid B + A)

Two cooperating mechanisms, both **host-only** (no plugin-repo manifest change required at this stage):

- **(B) Keyword→tool preload** — reuse the existing `SkillKeyword.skillId`. When `matchAllPluginIds` matches a
  plugin, the *same* matched keywords already carry a `skillId` that resolves (via `toolRegistry.findByName`) to a
  specific tool. Preload only those tools' full schemas. No round-trip.
- **(A) `tool_search` meta-tool** — for everything not preloaded, the model sees a compact **catalog** (name +
  1-line description, no JSON schema). Calling `tool_search({ query })` promotes matching tools into the live
  `tools[]` for the next round. Mirrors `request_plugin` exactly.

There is no settings flag for this mechanism. Per the #1176 update above, deferral engages only when the
eligible-tool count reaches `EAGER_TOOL_EXPOSURE_CEILING`; below the ceiling the active plugins' full schemas are
exposed eagerly. (The former `settings.experimental.toolDeferral` flag was dead and has been removed.)

### Tool visibility states

| State | In `tools[]` (full schema)? | In system prompt? |
|---|---|---|
| **Loaded** | yes | full name+desc (`<available-tools>`) |
| **Catalog** | no | name + 1-line (`<tool-catalog>`, "call tool_search to load") |
| **Hidden** | no | no (denied, user-disabled plugin, or out-of-policy surface) |

- **Loaded** = builtins + meta-tools (always); below the eager ceiling, every active plugin/MCP tool in scope;
  at/above the ceiling, only keyword-preloaded tools (B), `tool_search`-promoted tools, and explicit
  allowlist/carry-forward tools.
- **Catalog** = in-scope plugin/MCP tools that are not loaded, emitted only when `deferral === true`.
- `request_plugin` promotes an enabled runtime-loaded plugin into current-turn scope. User-disabled plugins are
  absent from `tools[]`, `<tool-catalog>`, and the requestable plugin catalog until the user re-enables them in UI.
  In deferral mode `request_plugin` must not promote every tool schema owned by that plugin.

## Data model changes

`ToolScope` in `src/engine/turn/types.ts` carries the contract:

```ts
interface ToolScope {
  activePluginIds: Set<string>;
  activeToolNames: Set<string>;   // NEW — individually-promoted/preloaded plugin+mcp tools
  includeBuiltins: boolean;
  includeMcp: boolean;
  deferral: boolean;              // true only when eligibleCount >= EAGER_TOOL_EXPOSURE_CEILING
}
```

`ToolRegistry.getToolSchemasForScope` (registry.ts:290) — plugin/MCP branch:

```
plugin/mcp tool included as LOADED iff:
  !scope.deferral && owner is in active scope
  OR scope.deferral && scope.activeToolNames.has(tool.name)
```

New `ToolRegistry.getToolCatalogForScope(scope)` → `{ name, description }[]` of visible plugin/MCP tools that are
**in scope** (plugin active OR mcp included) but **not** in `activeToolNames`. Description trimmed to first
sentence / ~100 chars for the catalog. Deny rules (`getVisibleTools`) apply first, same as the loaded path.

## File-by-file (host-only stage)

1. **`src/engine/turn/types.ts`, `tool-scope.ts`, `run-turn.ts`, and `query-loop.ts`**
   - Define `ToolScope` in `types.ts`.
   - `resolveToolScope` in `tool-scope.ts`: compute `activeToolNames` =
     `keywordEngine.matchToolNames(input)` (B) ∪ carried `lastTurnScope.activeToolNames` ∪ explicit fixed-surface
     allowlists. Keep `activePluginIds` as active owner scope; below the eager ceiling it exposes full active-plugin
     schemas, and at/above the ceiling it becomes catalog scope for individually loaded tools.
   - `run-turn.ts` persists carry-forward scope so a follow-up keeps loaded tools.
   - `query-loop.ts` wires `handleToolSearch` next to `handleRequestPlugin`: same intercept→promote→
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
- **No Fallback Code**: there is no settings branch — the count-based ceiling (`EAGER_TOOL_EXPOSURE_CEILING`)
  is the single gate, and the dead `experimental.toolDeferral` flag was removed (#1176). Eager full-schema
  exposure below the ceiling is intended behavior, not a fallback.
- **Budget contract**: request-input projection must include the same `tools[]` schemas that the provider request
  receives, and traces must expose loaded/deferred tool counts for both eager and deferred modes.

## Tests (host-only stage)

- `keyword-engine.test`: `matchToolNames` returns skillIds resolving to tools; ignores unmatched/unresolvable.
- `registry.test`: `getToolSchemasForScope` tool-level filtering;
  `getToolCatalogForScope` excludes loaded + denied tools.
- `tool-search.test` (mirror `request_plugin.test`): intercept, promote, caps, unknown-query error, tool-pair
  result synthesis, round refund, and broad-query top-N clamping.
- `conversation-loop` integration: below the eager ceiling, active plugin suites are exposed directly; at/above the
  ceiling, turn-1 `tools[]` = builtins + preloaded only and after `tool_search` the next round includes promoted tools.
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
