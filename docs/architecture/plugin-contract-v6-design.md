# Plugin Contract v6 — Colocated Tool Object + MCP Isolation Parity (#885)

> Status: **Design / awaiting implementation** — decisions §0 ratified by the maintainer 2026-07-09.
> Issue: #885 (feat(sdk): plugin contract simplification + MCP server isolation parity).
> Scope directive: this design **formally narrows** `docs/architecture/mcp-alignment-design.md` for the
> plugin-contract axis — LVIS borrows the **MCP `Tool` object shape** and pursues **MCP isolation parity**,
> but does **NOT** migrate the plugin contract to the full stateless MCP JSON-RPC wire (`2026-07-28` RC).
> The in-process **loopback topology already shipped** and is retained; the full-wire rewrite is out of scope.
> Rules honored: **No Fallback Code**, **single Source of Truth**, **clean excision of the compat layer**
> (CLAUDE.md §Field-Addition Sweep + §Cross-repo contract sync).

## 0. Ratified decisions (2026-07-09)

| # | Decision | Choice |
|---|---|---|
| Q1 surface model | How the tool contract is expressed | **Single canonical `tools: ToolObject[]`** aligned to the MCP `Tool` object shape, carrying LVIS surface flags (`model`/`ui`) + LVIS policy fields. `toolSchemas` map and `uiActions` map are **deleted**. |
| Q2 wire scope | Relationship to `mcp-alignment-design.md` full-wire migration | **Narrow to #885.** Borrow the MCP tool-**object** shape + isolation parity ONLY. No stateless `server/discover`/MRTR/per-request-`_meta` rewrite of the plugin contract in this epic. Loopback stays (shipped). |
| Q3 `category` | Fate of the deprecated per-tool `category` | **Removed** from the manifest SoT. `host-classifies-risk` is live; `category` is `deprecated:true` and unused by every first-party plugin. |
| b1 partition | MCP App UI partition isolation | **Per-server, ephemeral** — `lvis-mcp-app:<serverId>` (in-memory, non-persistent), replacing the shared `lvis-mcp-app`. |
| b2 detach | MCP App detached windows | **Host-owned** app-mode detach with a new `mcp-app:<serverId>:<cardId>` viewKey. **No** manifest/server `defaultMode` (would hand detach to an untrusted peer; the field does not exist today). |
| b3 lifecycle | Teardown on MCP disconnect | New `mcp.server.disconnected(serverId)` host event; **disable-in-place** rendered `ui://` cards (keep transcript history, show placeholder) + close detached `mcp-app:<serverId>:*` windows. |
| b4 permission | MCP-tool vs plugin-tool permission gate | **No behavior change — already at parity.** Both flow through the identical `ToolExecutor` pipeline; only the host-derived *risk-classification input* differs (external MCP = `network`/low-trust). Add a regression test + document. |
| b5 model | Unifying framing | **Ratified reality:** plugin = in-process loopback MCP-like extension; MCP server = out-of-process extension. Already the sole live registration path. |

## 1. Why (problem statement)

The plugin tool contract has **three scattered method surfaces** joined by name at load/projection time:

| Surface | Type | Home | Role |
|---|---|---|---|
| `tools[]` | `string[]` | `types.ts:163` | LLM-facing names; also the projection filter and the governed-vs-bypass discriminator |
| `toolSchemas[name]` | `Record<string,{…}>` | `types.ts:237-293` | Per-method `description, category?, pathFields?, writesToOwnSandbox?, version?, deprecatedSince?, replacedBy?, inputSchema` |
| `uiActions[name]` | `Record<string,{description?}>` | `types.ts:201` | Renderer IPC allowlist (UI-invokable methods) |

The scatter is a maintenance tax: load-time cross-field validation re-derives relationships (`toolSchemas` keys ⊆ `tools ∪ uiActions`, auth-∈-uiActions/∉-tools, the #1554 overlap warn), and the **governed-vs-bypass boundary reads two sources at once**:

```ts
// src/boot/plugin-tool-invocation.ts:33-37 (the #1554/#1556 fail-closed invariant)
declaredUiInvokableMethods(manifest).includes(toolName)   // uiActions membership
  && manifest.tools?.includes(toolName) !== true          // tools[] membership
```

Consolidating to one object per tool makes every one of these single-source, and lets the manifest object map 1:1 onto the MCP `Tool` the **already-live loopback projection** emits.

Real-manifest scale (grounds the churn estimate): meeting declares 28 tools with 24 also UI-invokable; ms-graph 27 tools, 12 UI-invokable, 3 UI-only (the auth trio). **A method is very commonly BOTH model-facing and UI-invokable** — the surface model must express this as two independent booleans, not an either/or.

## 2. Axis (a) — the colocated Tool Object (single SoT)

### 2.1 Verified MCP `Tool` shape (upstream-pinned)

`{ name, title?, icons?, description?, inputSchema:{type:"object", $schema?}, outputSchema?, annotations?, _meta? }`; JSON Schema dialect **2020-12**; `_meta` prefix reverse-DNS (`xyz.lvis/*`, never `*.mcp/*`). (Source: `mcp-alignment-design.md §8`, pinned verbatim against upstream `schema/draft/schema.ts`.)

### 2.2 Target `ToolObject`

```jsonc
{
  // --- MCP Tool object fields (projected 1:1) ---
  "name": "msgraph_email_list",          // underscore LLM tool name
  "title": "이메일 목록",                 // optional, human-readable
  "description": "받은 편지함의 최근 이메일…",
  "inputSchema": { "type": "object", "properties": { "top": { … } }, "additionalProperties": false },
  "icons": [ … ],                         // optional (MCP 2025-11-25)

  // --- LVIS surface flags (host-internal; projected to _meta on the wire) ---
  "model": true,   // LLM-facing → governed ToolExecutor path   (was: ∈ tools[])
  "ui": true,      // UI-invokable via renderer IPC bridge       (was: ∈ uiActions)

  // --- LVIS policy fields (host-internal SoT; projected to _meta["xyz.lvis/*"]) ---
  "pathFields": ["attachmentPath"],
  "writesToOwnSandbox": false,
  "version": "1.4.0",                     // optional; falls back to manifest version
  "deprecatedSince": "…", "replacedBy": "…"
  // NOTE: `category` REMOVED (Q3). `workerId` stays as-is where used.
}
```

- `uiActions` (the separate map) is **eliminated** — its only content was `{description?}`, now the object's own `description`.
- Defaults: `model` defaults **true**, `ui` defaults **false**. A tool with `model:false, ui:false` is rejected at load.

### 2.3 Preserving the #1554/#1556 governed-vs-bypass invariant (single-source)

| Case | Old shape | New shape | Route |
|---|---|---|---|
| LLM-only | `tools[]` only | `model:true` | governed ToolExecutor |
| Dual (24/28 meeting) | `tools[] ∩ uiActions` | `model:true, ui:true` | **governed** (model wins — fail-closed, matches #1554) |
| UI-only (auth, upload chunks) | `uiActions` only + schema | `model:false, ui:true` | uiActions runtime bypass (ceiling-capped per #1553) |
| invalid | neither | `model:false, ui:false` | rejected at load |

The predicate collapses to a single object read:

```ts
isUiOnly(tool) = tool.ui === true && tool.model !== true
```

This is **strictly stronger** than #1554 (which needed the unconditional overlap guard *because* the two surfaces were separate). The auth carve-out becomes an intra-object constraint: `auth.{statusTool,loginTool,logoutTool}` must reference objects with `model:false, ui:true` — replacing the two cross-surface checks.

### 2.4 Single-SoT mapping (each field's one post-migration home)

| Current field | Current home(s) | Single home (v6) | Derived consumers (all read the one home) |
|---|---|---|---|
| method name | `tools[]` / `toolSchemas` key / `uiActions` key (3×) | `tools[].name` | MCP projection, `declaredRuntimeMethods`, handler `methodMap`, gate |
| LLM-facing? | `tools[].includes(name)` | `tools[].model` | projection filter, governed-path gate |
| UI-invokable? | `uiActions[name]` present | `tools[].ui` | `declaredUiInvokableMethods`, renderer IPC allowlist, bypass gate |
| description | `toolSchemas[name].description` | `tools[].description` | MCP `Tool.description`, LLM catalog |
| inputSchema | `toolSchemas[name].inputSchema` | `tools[].inputSchema` | MCP `Tool.inputSchema`, arg validation |
| pathFields / writesToOwnSandbox / version / deprecatedSince / replacedBy / workerId | `toolSchemas[name].*` | `tools[].*` | `_meta["xyz.lvis/*"]` → canonical `Tool.*` |
| category | `toolSchemas[name].category?` | **removed** | host-classifies-risk (already live) |
| auth tool refs | `auth.*` + ∈uiActions ∉tools | `auth.*` → object w/ `model:false, ui:true` | intra-object auth validation |

**No field is derivable from two places post-migration.** `capabilities[]` stays a separate array (dependency-tag axis, deliberately not a tool-object field; kept out of MCP projection).

## 3. Compat layer — strictly transitional, with a first-class removal phase

Per **No Fallback Code** + the project's clean-excision principle: the compat layer is a bridge, **not** a permanent dual path.

### 3.1 Single normalization point

A pure `normalizeManifest(raw): NormalizedManifest` in the SDK, invoked by the host in `parsePluginJson` (`manifest-validation.ts:211`) immediately after AJV validation. During the window the AJV schema accepts BOTH shapes (a `oneOf` on `tools`: legacy `string[]` vs `ToolObject[]`).

- Legacy input (`tools[0]` is a string) → build objects by joining `toolSchemas[name]` (fields) + `uiActions` membership (`ui:true`), `model:true` for names in `tools[]`, and synthesize `model:false, ui:true` objects for `uiActions`-only schema keys.
- Colocated input (`tools[0]` is an object) → pass through.
- **Invariant:** `normalizeManifest` is the ONLY code that reads legacy `toolSchemas`/`uiActions`; every consumer (`manifestToolsToMcpTools`, `declaredRuntimeMethods`, the gate) reads the normalized array. The compat surface is excisable in one file — no `(x as any)` leaks to call sites.

### 3.2 Removal gate (must be GREEN before Phase R)

1. All 6 first-party plugins + template publish colocated manifests (a3):
   `for r in meeting ms-graph work-assistant local-indexer lge-api git template; do node -e "process.exit(typeof require('../lvis-plugin-'+process.argv[1]+'/plugin.json').tools[0]==='object'?0:1)" "$r" || echo "NOT MIGRATED: $r"; done`
2. Marketplace catalog re-published; installed-manifest scan on a test profile shows zero legacy shapes.
3. `PluginMarketplaceItem.toolSchemas`/`.tools` consumers migrated (`types.ts:615,646`, SDK).

### 3.3 Deletion surface (Phase R) + sweep

Delete from host: `types.ts` `toolSchemas?`/`uiActions?`/`PluginUiActionSpec`; the `oneOf` legacy branch + cross-field checks in `manifest-validation.ts`; the union type on `tools`; legacy branches in `plugin-loader.ts`/`plugin-server-projection.ts`/`plugin-tool-invocation.ts`. Delete from SDK: `toolSchemas`/`uiActions`/`PluginUiActionSpec` + the `oneOf` in `schemas/plugin-manifest.schema.json`.

Sweep gate (must be **0** across host + SDK + 6 plugins + template + marketplace):
```bash
grep -rn "toolSchemas\|uiActions\|PluginUiActionSpec\|declaredUiInvokableMethods" \
  src/ ../lvis-plugin-sdk/src ../lvis-plugin-*/plugin.json ../lvis-plugin-template ../lvis-marketplace \
  | grep -v "__tests__\|CHANGELOG"
```
Plus `bunx tsc --noEmit` rc=0 (ground-truth over LSP ghosts) + `bunx vitest run` + `bun run build`.

## 4. Axis (b) — MCP isolation parity

- **(b1) Per-server ephemeral partition.** `McpAppView.tsx:172` hardcodes the shared non-persistent `lvis-mcp-app`; two servers share one cookie/IndexedDB jar (server B's `ui://` card can read A's storage). Move to `lvis-mcp-app:<serverId>` (serverId from `McpUiPayload.serverId`), with the CDN-allowlist `webRequest` gate installed lazily per server (mirrors the per-plugin `persist:plugin:*` lazy install). Ephemeral (in-memory) pairs cleanly with b3 teardown.
- **(b2) Host-owned detach.** Extend `ALLOWED_VIEW_KEYS` (`window-manager.ts:45`) with `mcp-app:<serverId>:<cardId>`; add `lvis:mcp:open-detached` IPC → `openDetachedTab`, mounting `McpAppView` in the detached shell. Widen `will-attach-webview` (`:553`) to accept the b1 partition prefix. **Detach stays host-owned** — no manifest `defaultMode`. (#886 is CLOSED NOT_PLANNED; the `window.defaultMode` it referenced does not exist in code.)
- **(b3) Disconnect teardown.** `McpManager.killSwitch`/`removeConfig`/`disconnectAll` tear down tools only. Emit `mcp.server.disconnected(serverId)`; the renderer disables-in-place `ui://` cards whose `payload.serverId === serverId` (placeholder, transcript preserved) and `WindowManager` closes detached `mcp-app:<serverId>:*` windows (scoped sweep like `closeAllDetached`).
- **(b4) Permission parity — no change.** External-MCP tools (`mcpToolToTool` → `source:mcp, category:network, low trust`) and plugin loopback tools (`mcpToolToPluginTool` → `source:plugin`) BOTH traverse the identical `ToolExecutor.executeOne` pipeline (Layer-1 deny / reviewer / ApprovalGate / audit / effect-ledger); only the host-derived risk-classification input differs (deny-stricter for MCP). Add an executor-level invariant test (`source:"mcp"` traverses the same reviewer/audit steps as `source:"plugin"`) + document in `architecture.md §6.4`. The #1553/#1554/#1556 `uiActions` bypass has **no MCP analog** (external servers have no `uiActions`).
- **(b5) Ratified model.** In-process plugins → `persist:plugin:<hash>` (storage-bearing, trusted); out-of-process MCP servers → `lvis-mcp-app:<serverId>` (b1) — the same per-extension isolation principle, differing only by persistence/trust boundary.

## 5. Phased plan + cross-repo sweep

| Phase | Scope | Gate |
|---|---|---|
| **a1** | This design doc → maintainer sign-off | agreement (done, §0) |
| **a2 (SDK v6)** | `ToolObject` type + `tools: string[] \| ToolObject[]` `oneOf` schema + `normalizeManifest` compat | SDK tests; host validator native-field probes updated |
| **a3** | Migrate 6 first-party manifests + template to colocated shape; bump each to SDK v6 | each loads + registers; tsc/vitest green |
| **a4** | Host validator intra-object auth/surface checks replace cross-field checks; `manifestToolsToMcpTools`/`declaredRuntimeMethods`/gate read normalized array | full vitest + pre-push |
| **b1+b2+b3** | Per-server partition + detached viewKey + disconnect teardown (b1 lands with b2 — the `will-attach-webview` allowlist couples them) | Playwright e2e (renderer) + cluster review (touches `src/main`, IPC trust boundary) |
| **b4** | Executor parity regression test + docs (no behavior change) | test asserts mcp==plugin traversal |
| **R (removal)** | Delete legacy `toolSchemas`/`uiActions`/`PluginUiActionSpec` + compat branch (§3) | removal gate §3.2 green; sweep §3.3 = 0; tsc/vitest/build green |

**Cross-repo sweep (must move in-session per CLAUDE.md §Cross-repo contract sync):**
`lvis-app` (host) · `lvis-plugin-sdk` (v5.22.0 → **v6**) · 6 plugins (`meeting`, `ms-graph`, `work-assistant`, `local-indexer`, `lge-api`, `git`) · `lvis-plugin-template` · `lvis-marketplace` (catalog `PluginMarketplaceItem.tools`/`.toolSchemas` mirror + publisher schema).

## 6. Open items (non-blocking)

- Confirm `lvis-plugin-work-assistant-briefing-routine` has **no** standalone `plugin.json` (excluded from the migration set — verified: not present in the workspace manifest listing).
- b1 lazy per-server CDN-allowlist registration: confirm the `webRequest` filter can be (re)installed for a dynamic partition name without leaking a prior server's allowlist.
- Cluster review is REQUIRED for the (b) phase (sensitive `src/main` + IPC boundary) — schedule at (b) merge.

## References (file:line evidence)

- `src/plugins/types.ts:163,201,237-293` — `tools[]`, `uiActions`, `toolSchemas` (the three surfaces).
- `src/plugins/runtime/manifest-validation.ts:494-519,525-548,592-607,629-638` — cross-field checks the colocated shape replaces.
- `src/plugins/runtime/plugin-loader.ts:28-40` — `declaredUiInvokableMethods`/`declaredRuntimeMethods`.
- `src/boot/plugin-tool-invocation.ts:33-37,84-89` — the #1554/#1556 governed-vs-bypass predicate (two sources today).
- `src/mcp/plugin-server-projection.ts:141-150,117-125` — forward projection (`tools[]` filter + `_meta` carriers) — the already-live path.
- `src/mcp/plugin-tool-from-mcp.ts:130-182` — reverse projection (`_meta` → canonical `Tool`).
- `src/boot/steps/plugin-runtime.ts:517-521` + `.../lifecycle.ts:122-130` — loopback is the sole live registration path (legacy direct-registration already removed).
- `src/tools/executor.ts:655-662,835-893,857-863` — uniform `source`/trust; MCP and plugin tools same pipeline (b4).
- `src/ui/renderer/components/McpAppView.tsx:172` — shared non-persistent `lvis-mcp-app` partition (b1).
- `src/main/window-manager.ts:45,427-637,646-670` — `ALLOWED_VIEW_KEYS`, host-owned detach (b2).
- `src/mcp/mcp-manager.ts:205-217,256-275,468-489` — disconnect tears down tools only (b3).
- `docs/architecture/mcp-alignment-design.md §0,§3.3,§8` — the full-wire direction this doc narrows + the verified MCP `Tool` shape.
