# Plugin Contract v6 — Pure MCP Tool Object (single SoT) + MCP Isolation Parity (#885)

> Status: **Design / awaiting implementation** — decisions §0 ratified by the maintainer 2026-07-09
> (surface model + proprietary-field minimization ratified same day, second round).
> Issue: #885 (feat(sdk): plugin contract simplification + MCP server isolation parity).
> Scope directive: this design **formally narrows** `docs/architecture/mcp-alignment-design.md` for the
> plugin-contract axis — LVIS adopts the **MCP `Tool` object shape verbatim** (manifest shape == wire shape)
> and pursues **MCP isolation parity**, but does **NOT** migrate the plugin contract to the full stateless
> MCP JSON-RPC wire (`2026-07-28` RC). The in-process **loopback topology already shipped** and is retained;
> the full-wire rewrite is out of scope.
> Rules honored: **No Fallback Code**, **single Source of Truth**, **clean excision of the compat layer**
> (CLAUDE.md §Field-Addition Sweep + §Cross-repo contract sync), and MCP's own trust rule
> ("annotations from untrusted servers MUST be treated as untrusted") — no self-declared field may flip a
> host security verdict.

## 0. Ratified decisions (2026-07-09)

| # | Decision | Choice |
|---|---|---|
| Q1 surface model | How the tool contract is expressed | **Single canonical `tools: Tool[]`** where each element is a **pure MCP `Tool` object** (`name, title?, description?, inputSchema, icons?, _meta?`). `toolSchemas` map and `uiActions` map are **deleted**. |
| Q2 wire scope | Relationship to `mcp-alignment-design.md` full-wire migration | **Narrow to #885.** Adopt the MCP tool-**object** shape + isolation parity ONLY. No stateless `server/discover`/MRTR rewrite in this epic. Loopback stays (shipped). |
| Q3 `category` | Fate of the deprecated per-tool `category` | **Removed.** `host-classifies-risk` is live; a plugin grading its own danger is not a control. |
| **Q4 field minimization** | Fate of the remaining LVIS-proprietary tool fields | **6 → 1.** `model`+`ui` → folded into the **standard** `_meta.ui.visibility` (MCP Apps SEP-1865). `writesToOwnSandbox`, `workerId`, per-tool `version`, `deprecatedSince`/`replacedBy` → **removed from the manifest** (host-derived / host-assigned / plugin-level / YAGNI). Only `_meta["xyz.lvis/pathFields"]` remains LVIS-proprietary. |
| **Q5 manifest form** | Authoring shape in `plugin.json` | **Pure form** — the manifest tool object IS the MCP `Tool` (including `_meta`). Manifest shape == wire shape; no top-level `model`/`ui` sugar, no translation layer for the new shape (`normalizeManifest` handles the LEGACY shape only). |
| **Q6 visibility default** | Interpretation when `_meta.ui.visibility` is absent | **Standard SEP-1865 default `["model","app"]`** (round 3 — LVIS hosts external MCP tools with the same semantics; a host-private reinterpretation cannot be imposed on the ecosystem). Safe by construction: the default yields only governed dual routing; the ungoverned bypass requires an explicit `["app"]`-only declaration. Resolved to an explicit array once at load. |
| b1 partition | MCP App UI partition isolation | **Per-server, ephemeral** — `lvis-mcp-app:<serverId>` (in-memory), replacing the shared `lvis-mcp-app`. |
| b2 detach | MCP App detached windows | **Host-owned** app-mode detach with a new `mcp-app:<serverId>:<cardId>` viewKey. **No** manifest/server `defaultMode`. |
| b3 lifecycle | Teardown on MCP disconnect | New `mcp.server.disconnected(serverId)` host event; **disable-in-place** rendered `ui://` cards + close detached `mcp-app:<serverId>:*` windows. |
| b4 permission | MCP-tool vs plugin-tool permission gate | **No behavior change — already at parity.** Both flow through the identical `ToolExecutor` pipeline. Add a regression test + document. |
| b5 model | Unifying framing | **Ratified reality:** plugin = in-process loopback MCP-like extension; MCP server = out-of-process extension. Already the sole live registration path. |

## 1. Why (problem statement)

The plugin tool contract has **three scattered method surfaces** joined by name at load/projection time:

| Surface | Type | Home | Role |
|---|---|---|---|
| `tools[]` | `string[]` | `types.ts:163` | LLM-facing names; also the projection filter and the governed-vs-bypass discriminator |
| `toolSchemas[name]` | `Record<string,{…}>` | `types.ts:237-293` | Per-method `description, category?, pathFields?, writesToOwnSandbox?, workerId?, version?, deprecatedSince?, replacedBy?, inputSchema` |
| `uiActions[name]` | `Record<string,{description?}>` | `types.ts:201` | Renderer IPC allowlist (UI-invokable methods) |

The scatter forces load-time cross-field validation (`toolSchemas` keys ⊆ `tools ∪ uiActions`, auth-tool placement rules, the #1554 overlap warn), and the **governed-vs-bypass security boundary reads two sources at once** (`src/boot/plugin-tool-invocation.ts:33-37`). Consolidating to one MCP-shaped object per tool makes every one of these single-source, and feeds the **already-live loopback projection** (`src/mcp/plugin-server-projection.ts`) without a translation step.

Real-manifest scale (per-surface, verified 2026-07-09): meeting declares 28 `tools[]` entries (24 also UI-invokable) **plus 4 UI-only methods (the schemaless upload quad) — 32 tool objects total after migration**; ms-graph 27 `tools[]`, 12 UI-invokable, 3 UI-only (the auth trio) — 30 objects. **A method is very commonly BOTH model-facing and UI-invokable** — the surface model expresses this as membership in a visibility array, not an either/or.

## 2. Axis (a) — the tool object is a pure MCP `Tool`

### 2.1 Verified MCP `Tool` shape (upstream-pinned)

`{ name, title?, icons?, description?, inputSchema:{type:"object", $schema?}, outputSchema?, annotations?, _meta? }`; JSON Schema dialect **2020-12**; `_meta` prefix reverse-DNS (`xyz.lvis/*`, never `*.mcp/*`). (Source: `mcp-alignment-design.md §8`, pinned verbatim against upstream `schema/draft/schema.ts`.)

### 2.2 Target shape — manifest == wire

```jsonc
{
  "tools": [
    {
      // --- pure MCP Tool fields ---
      "name": "msgraph_email_list",
      "title": "이메일 목록",                       // optional
      "description": "받은 편지함의 최근 이메일…",
      "inputSchema": { "type": "object", "properties": { "top": { … } }, "additionalProperties": false },
      "icons": [ … ],                               // optional (MCP 2025-11-25)
      "_meta": {
        // STANDARD (MCP Apps SEP-1865, extension io.modelcontextprotocol/ui):
        // which surfaces may invoke this tool. Replaces LVIS's tools[]/uiActions split.
        "ui": { "visibility": ["model", "app"] },
        // The ONLY remaining LVIS-proprietary key: names the input-schema args that
        // are filesystem paths, fed into the HOST-side allowed-directories check.
        "xyz.lvis/pathFields": ["attachmentPath"]
      }
    },
    {
      "name": "msgraph_status",
      "description": "현재 인증 상태를 반환…",
      "inputSchema": { "type": "object", "properties": {} },
      "_meta": { "ui": { "visibility": ["app"] } }   // UI-only (the old uiActions-only case)
    }
  ],
  "auth": { "statusTool": "msgraph_status", "loginTool": "msgraph_auth", "logoutTool": "msgraph_signout" }
}
```

- The `uiActions` map is **eliminated**; the `toolSchemas` map is **eliminated**. Each tool is one object.
- **Visibility default — STANDARD `["model","app"]`, resolved explicitly at load (round 3, 2026-07-09):**
  when `_meta.ui.visibility` is absent, LVIS applies **SEP-1865's own default**. Rationale (maintainer):
  LVIS hosts external MCP servers whose tools carry the same `_meta.ui` semantics — a host-private
  reinterpretation of the standard default cannot be imposed on the wider MCP ecosystem, so LVIS must not
  diverge. This is **safe by construction**: the default can only ever produce GOVERNED access — a
  defaulted tool is dual (`model`+`app`), and the "model wins" host routing sends every webview invocation
  of a dual tool through the governed `ToolExecutor` (Layer-1 denies, reviewer, approval gate with
  genuine-user-activation semantics, audit). The **ungoverned** uiActions runtime bypass still requires an
  **explicit app-only declaration** (`["app"]` without `"model"`) — the security-critical surface remains
  opt-in and can never arise from the default (fail-closed by construction).
  The absent case is resolved to an explicit array ONCE at manifest load (`normalizeManifest` output is
  always explicit — single SoT; no consumer re-derives the default), and the wire projection always emits
  `visibility` explicitly. `visibility: []` (a tool reachable by neither surface) is rejected at load.
  **Known delta vs today (accepted):** a newly-authored pure-form tool that omits `_meta.ui` becomes
  webview-invokable *through the governed path* (today's `uiActions` was opt-in even for governed access).
  Authors wanting LLM-only tools declare `visibility: ["model"]` explicitly — and the legacy→pure
  converter emits exactly that for `tools[]`-only methods, so **migrated manifests preserve today's exact
  surface**; the wider default applies only to future hand-authored omissions.
- The auth trio must reference tools whose visibility is exactly `["app"]` — replaces the two
  cross-surface auth checks with one intra-object lookup.
- **Optional standard MCP fields (critic-u1 ruling, adopted):** `outputSchema` is **accepted and
  projected** (standard, harmless, keeps Q5 "manifest==wire" literally true). `annotations` is
  **schema-REJECTED in the manifest** — this is security-mandated, not minimization: plugin-authored
  `readOnlyHint`/`destructiveHint` are exactly the untrusted self-claims Q4 removed; the host derives its
  own interop annotations at projection time and never reads inbound ones (`plugin-server-projection.ts`).
- **Host compatibility gate — REUSE `requires.minAppVersion` (design-u1/design-u4 discovery, verified):**
  the mechanism already exists and is live-**enforced** — install-preflight at `marketplace.ts:733-737`
  (`incompatible-app-version`) AND load/activate at `runtime/index.ts:2056-2060` (`markIncompatibleAppVersion`);
  `manifest-validation.ts:655-667` is the SemVer *format* re-validation only. The SDK schema
  (`plugin-manifest.schema.json:564`) + SDK types (`index.ts:469-473`) carry it, and
  `lvis-plugin-local-indexer` already ships `minAppVersion:"0.4.2"`. Every a3 pure-form manifest declares
  `requires.minAppVersion: "<the a4 host release version>"`, so a **pre-a4 host refuses the update at the
  marketplace install preflight — BEFORE any tools parsing — with a clean version error**, not a confusing
  schema failure. It is an **a3-manifest policy, NOT schema-required on the pure arm** (over-coupling the
  tool-shape axis to the version axis, and the preflight is the real gate anyway); therefore a3/marketplace
  **publish-time CI enforces the floor** (reject a pure-form manifest lacking `requires.minAppVersion >=`
  the a4 host version) so the policy is not merely advisory. No new field is invented (single SoT).
  Belt-and-suspenders: a3 marketplace publication is held until the a4 host is GA. (Supersedes the earlier
  `engines.lvisHost` sketch — that premise assumed no gate existed; the grep missed the differently-named
  existing field.)

### 2.3 Preserving the #1554/#1556 governed-vs-bypass invariant (single-source)

| Case | Old shape | New shape (`_meta.ui.visibility`) | Route |
|---|---|---|---|
| LLM-only | `tools[]` only | `["model"]` (explicit; the legacy converter emits this for `tools[]`-only methods) | governed ToolExecutor |
| Dual (24/28 meeting) | `tools[] ∩ uiActions` | `["model","app"]` (also the resolved value when `_meta.ui` is absent — standard default) | **governed** (model wins — fail-closed, matches #1554) |
| UI-only (auth, upload chunks) | `uiActions` only + schema | `["app"]` (always explicit — never reachable via the default) | uiActions runtime bypass (ceiling-capped per #1553) |
| Neither | — | `[]` | rejected at load |

```ts
// single-source predicate — one array read, no cross-surface join
isUiOnly(tool) = visibility.includes("app") && !visibility.includes("model")
```

This mapping is 1:1 with SEP-1865's own normative host rules ("Host MUST NOT include tools in the agent's
tool list when their visibility does not include `model`"; "Host MUST reject `tools/call` requests from
apps for tools that don't include `app`"). LVIS's **"model wins for dual tools"** routing (a dual tool
invoked from the webview still goes through the governed executor) is a host policy layered on top of
visibility — it stays host-side, exactly as today.

### 2.4 Single-SoT mapping — every current field's disposition

| Current field | Current home(s) | v6 disposition | Evidence |
|---|---|---|---|
| method name | `tools[]` / `toolSchemas` key / `uiActions` key (3×) | `tools[].name` | — |
| LLM-facing? | `tools[].includes(name)` | `_meta.ui.visibility ∋ "model"` | **standard** (SEP-1865) |
| UI-invokable? | `uiActions[name]` present | `_meta.ui.visibility ∋ "app"` | **standard** (SEP-1865); OpenAI Apps SDK production analog (`openai/widgetAccessible` → migrating to the same array) |
| description / inputSchema / title / icons | `toolSchemas[name].*` | `tools[].*` (MCP fields) | — |
| pathFields | `toolSchemas[name].pathFields?` | `_meta["xyz.lvis/pathFields"]` — **the only LVIS key kept** | OpenAI `_meta["openai/fileParams"]` is a structural twin; the *gate* stays host-side (a lying declaration only adds checks, never bypasses one) |
| category | `toolSchemas[name].category?` | **removed** (Q3) | host-classifies-risk live; MCP MUST-untrusted rule |
| writesToOwnSandbox | `toolSchemas[name].writesToOwnSandbox?` | **removed — host-derived.** Containment of resolved path args inside the plugin sandbox root is computed host-side per invocation (the runtime verification was always the real signal; the flag was an untrusted self-claim). LVIS already has the derivation (`sandboxFsContainedProvider` / `isActiveSandboxFilesystemContainedForPluginEffects`). | MCP MUST-untrusted rule; **Codex #7635 declined the analogous self-attested sandbox field (closed not-planned)**; census: **0 declarations** across all 6 plugins |
| workerId | `toolSchemas[name].workerId?` | **removed as manifest input — host-assigned runtime binding only.** The real proof mechanism already exists: `spawnWorker`'s wrapped-spawn path registers `(pluginId, workerId)` in `sandbox-capability.ts`; the manifest field was advisory-only by its own JSDoc ("not an execution proof"). | no external per-tool worker concept exists; census: **0 declarations** |
| per-tool version | `toolSchemas[name].version?` | **removed — plugin-level `version` only.** | base MCP `Tool` has no version field; Claude Code / Codex version at package level only; census: **0 declarations** (every tool inherits the manifest version today) |
| deprecatedSince / replacedBy | `toolSchemas[name].*` | **removed (YAGNI).** No producer exists — 0 manifest declarations AND no builtin tool sets them; only dormant Tool-level machinery in `tools/base.ts`/`registry.ts`. If ever needed, the FastMCP `_meta.fastmcp.version` precedent shows the re-introduction home (`_meta["xyz.lvis/*"]`). | census overrides the external-research KEEP recommendation |
| auth tool refs | `auth.*` + 2 cross-surface checks | `auth.*` → tool with visibility `["app"]` (intra-object) | — |

**No field is derivable from two places post-migration, and no self-declared manifest field can flip a
host security verdict.** `capabilities[]` stays a separate manifest array (dependency-tag axis, deliberately
not a tool-object field; kept out of MCP projection).

### 2.4a Two host-reader migrations found in the completeness census (2026-07-09)

The first-pass census enumerated the projection/gate/runtime-method readers but missed two direct
`manifest.tools`(string[]) / `manifest.toolSchemas` readers. Both break under `Tool[]` and are part of a4:

- **`knownToolOwners`** (`runtime/index.ts:415,457,1018`, teardowns `:408-409,1090-1091`, clear `:1942`)
  iterates `manifest.tools` and keys a `Map<toolName,pluginId>`. Under `Tool[]` the key becomes an object,
  so a4 must read `.map(t => t.name)`. **Security decision — MODEL-ONLY** (`filter(isModelVisible).map(name)`):
  this map feeds `resolveToolOwner` (`:1523` — `methodMap.get(m)?.pluginId ?? knownToolOwners.get(m)`, so it
  is only the pre-runtime `??` fallback; `methodMap` carries ALL names incl. UI-only and is authoritative at
  runtime) → `assertPluginToolAccess` (plugin-to-plugin access control) and `throwIfToolOwnerNotReady`
  (`:2012`, which already early-returns for a UI-only method today). Today's `tools`(string[]) is model-facing
  only, so a naive all-names `.map` would silently add the app-only auth trio to the ownership map — an
  access-control widening. Model-only reproduces today's EXACT set (byte-for-byte behavior-preserving) and
  loses no UI-only ownership resolution (methodMap covers it). Verified against real code + critic-u2b.
- **`buildPluginCard`** (`runtime/cards.ts:24,28,35,48-50`) filters `allTools` as if elements were names and
  sources card descriptions from `manifest.toolSchemas[name].description` (a field v6 deletes). a4 retargets:
  filter on `t.name` with an `isModelVisible` pre-filter (card stays LLM-facing, auth tools hidden as today),
  descriptions from `tool.description`, `PluginCard.tools`(string[]) = the filtered names.
- **Writer counterpart (Phase R):** `marketplace.ts` `buildInstalledManifest` (`:1564-1603`) mirrors catalog
  fields into the on-disk `plugin.json` — `:1588 manifest.uiActions` and `:1591 manifest.toolSchemas` are
  DELETED in R (`:1577 tools` retargets to the pure `Tool[]` mirror). Caught by the §3.3 sweep + tsc tripwire
  when the `PluginMarketplaceItem` fields are removed.

### 2.5 External-reference evidence (field-minimization audit)

The 2026-07-09 second-round decisions are grounded in an external audit of MCP (core + Apps SEP-1865),
OpenAI Apps SDK, Claude Code, and Codex CLI:

- **Cross-cutting rule** — MCP spec: *"clients MUST consider tool annotations to be untrusted unless they
  come from trusted servers."* Any self-declared field that flips a host verdict is the anti-pattern this
  warns against → `writesToOwnSandbox`/`workerId` removal.
- **`model`+`ui` → `_meta.ui.visibility`** — SEP-1865 (`io.modelcontextprotocol/ui`, Stable 2026-01-26)
  defines `visibility?: Array<"model"|"app">` with normative host enforcement, and its design rationale
  **explicitly rejected the two-boolean shape** ("Cleaner than OpenAI's two-field approach… rejected as
  redundant") — the exact shape LVIS would otherwise have invented. OpenAI Apps SDK is migrating its legacy
  `openai/widgetAccessible` + `openai/visibility` pair to the same array. LVIS already adopts this extension
  (M8 Apps permission gate shipped), so the fold adds zero new surface.
- **`pathFields`** — no host trusts tool-declared path *safety* (Claude Code: host-side permission rules +
  hardcoded path-arg canonicalization; Codex: `writable_roots` host config; MCP `roots`: host-declared,
  per-connection). But the narrower concern "which args ARE paths" has a shipped production twin:
  OpenAI `_meta["openai/fileParams"]: string[]`. Kept as a routing hint whose failure direction is safe.
- **Codex #7635** — "MCP tools don't respect sandboxing" closed **not-planned**; Codex chose OS-sandbox +
  approval over self-attested containment. Direct precedent for removing `writesToOwnSandbox`.
- **Per-tool versioning** — no MCP field; open upstream issues (#1039/#1915); FastMCP carries it as a vendor
  `_meta` extension. Claude Code/Codex: package-level only.

## 3. Compat layer — strictly transitional, with a first-class removal phase

Per **No Fallback Code** + clean excision: the compat layer is a bridge, **not** a permanent dual path.

### 3.1 Single normalization point

A pure `normalizeManifest(raw): NormalizedManifest` in the SDK, invoked by the host in `parsePluginJson`
(`manifest-validation.ts:211`) immediately after AJV validation. During the window the AJV schema accepts
BOTH shapes (a `oneOf` on `tools`: legacy `string[]` vs MCP `Tool[]`).

- Legacy input (`tools[0]` is a string) → build pure MCP `Tool` objects: join `toolSchemas[name]` fields,
  compile surface membership to `_meta.ui.visibility` (`tools[]`-only → `["model"]`; dual → `["model","app"]`;
  `uiActions`-only → `["app"]`), move `pathFields` → `_meta["xyz.lvis/pathFields"]`, and **drop**
  `category`/`writesToOwnSandbox`/`workerId`/per-tool `version`/`deprecatedSince`/`replacedBy` (Q3/Q4 —
  logged once per plugin at load during the window so authors notice).
- New input (`tools[0]` is an object) → pass through verbatim (**no translation — manifest IS the wire shape**).
- **Invariant:** `normalizeManifest` is the ONLY code that reads legacy `toolSchemas`/`uiActions`; every
  consumer reads the normalized `Tool[]`. The full host-reader set (census-verified 2026-07-09) is:
  `manifestToolsToMcpTools`, `declaredRuntimeMethods`/`declaredUiInvokableMethods`, the governed-vs-bypass
  gate, **`knownToolOwners` population (`runtime/index.ts:415,457,1018` + teardowns `:408-409,1090-1091`)**,
  and **`buildPluginCard` (`runtime/cards.ts:24,28,35,48-50`)**. The last two were missed by the first-pass
  census and are load-bearing (§2.4a). The compat surface is excisable in one file — no `(x as any)` leaks
  to call sites.

### 3.2 Removal gate (must be GREEN before Phase R)

1. All 6 first-party plugins + template publish pure-form manifests (a3):
   `for r in meeting ms-graph work-assistant local-indexer lge-api git template; do node -e "process.exit(typeof require('../lvis-plugin-'+process.argv[1]+'/plugin.json').tools[0]==='object'?0:1)" "$r" || echo "NOT MIGRATED: $r"; done`
2. Marketplace catalog re-published; installed-manifest scan on a test profile shows zero legacy shapes.
3. `PluginMarketplaceItem.toolSchemas`/`.tools` consumers migrated (`types.ts:615,646`, SDK).

### 3.3 Deletion surface (Phase R) + sweep

Delete from host: `types.ts` `toolSchemas?`/`uiActions?`/`PluginUiActionSpec` **and the removed field types**
(`writesToOwnSandbox`, manifest `workerId`, per-tool `version`, `deprecatedSince`, `replacedBy` manifest
plumbing — the host-side derivations in `sandbox-capability.ts`/`permission-manager.ts` stay, now fed only by
runtime state); the `oneOf` legacy branch + cross-field checks in `manifest-validation.ts` (incl. the workerId
native-field probes); legacy branches in `plugin-loader.ts`/`plugin-server-projection.ts`/`plugin-tool-invocation.ts`;
the legacy-mirror **writer** `marketplace.ts` `buildInstalledManifest` (`:1588 manifest.uiActions`, `:1591
manifest.toolSchemas` — deleted; `:1577 tools` already writes the pure `Tool[]` mirror);
the dormant `deprecatedSince`/`replacedBy` redirect machinery in `tools/base.ts`/`tools/registry.ts` (no producer).
Delete from SDK: `toolSchemas`/`uiActions`/`PluginUiActionSpec` + the `oneOf` + removed-field schema in
`schemas/plugin-manifest.schema.json`.

Sweep gate (must be **0** across host + SDK + 6 plugins + template + marketplace):
```bash
grep -rn "toolSchemas\|uiActions\|PluginUiActionSpec\|declaredUiInvokableMethods\|writesToOwnSandbox\|deprecatedSince\|replacedBy" \
  src/ ../lvis-plugin-sdk/src ../lvis-plugin-*/plugin.json ../lvis-plugin-template ../lvis-marketplace \
  | grep -v "__tests__\|CHANGELOG"
```
Plus `bunx tsc --noEmit` rc=0 (ground-truth over LSP ghosts) + `bunx vitest run` + `bun run build`.
Deleting the `tools` union type statically proves no fallback branch survives.

## 4. Axis (b) — MCP isolation parity

- **(b1) Per-server ephemeral partition.** `McpAppView.tsx:172` hardcodes the shared non-persistent
  `lvis-mcp-app`; two servers share one cookie/IndexedDB jar. Move to `lvis-mcp-app:<serverId>`
  (serverId from `McpUiPayload.serverId`), with the CDN-allowlist `webRequest` gate installed lazily per
  server (mirrors the per-plugin `persist:plugin:*` lazy install). Ephemeral pairs cleanly with b3 teardown.
- **(b2) Host-owned detach.** Extend `ALLOWED_VIEW_KEYS` (`window-manager.ts:45`) with
  `mcp-app:<serverId>:<cardId>`; add `lvis:mcp:open-detached` IPC → `openDetachedTab`, mounting `McpAppView`
  in the detached shell. Widen `will-attach-webview` (`:553`) to accept the b1 partition prefix. **Detach
  stays host-owned** — no manifest `defaultMode`. (#886 is CLOSED NOT_PLANNED; the `window.defaultMode` it
  referenced does not exist in code.)
- **(b3) Disconnect teardown.** `McpManager.killSwitch`/`removeConfig`/`disconnectAll` tear down tools only.
  Emit `mcp.server.disconnected(serverId)`; the renderer disables-in-place `ui://` cards whose
  `payload.serverId === serverId` (placeholder, transcript preserved) and `WindowManager` closes detached
  `mcp-app:<serverId>:*` windows (scoped sweep like `closeAllDetached`).
- **(b4) Permission parity — no change.** External-MCP tools (`mcpToolToTool` → `source:mcp,
  category:network, low trust`) and plugin loopback tools (`mcpToolToPluginTool` → `source:plugin`) both flow
  through the one `ToolExecutor.executeOne` pipeline and **converge at the same governed chokepoints —
  Layer-1 deny, ApprovalGate, audit, and the effect-ledger shadow**; the host-derived risk-classification
  input is the only INPUT difference (deny-stricter for MCP). **b4-verified refinement (2026-07-10):** the
  reviewer *auto-approve* lane is NOT a shared step — a low-trust foreign MCP peer is never silently
  auto-approved, so `PermissionManager.categoryBasedDecision` short-circuits every low-trust (MCP) call to a
  bare `ask` (no `reviewer.route`) and it escalates STRAIGHT to the ApprovalGate, while a medium-trust plugin
  runs the classify/foreground-auto lane first. This is a sanctioned, fail-safe *consequence* of the
  trust-tier split (an input-driven path fork toward the stricter posture), not a regression — both still
  converge at the governed gate. Locked by `executor-mcp-plugin-parity.test.ts` (asserts gate/audit/
  effect-ledger convergence + the classify-lane fork as the only sanctioned divergence) + documented in
  `architecture.md §Tool Governance → "MCP↔plugin execution parity (invariant)"`. The #1553/#1554/#1556
  `uiActions` bypass has **no MCP analog** (external servers have no `uiActions`).
- **(b5) Ratified model.** In-process plugins → `persist:plugin:<hash>` (storage-bearing, trusted);
  out-of-process MCP servers → `lvis-mcp-app:<serverId>` (b1) — the same per-extension isolation principle,
  differing only by persistence/trust boundary.

## 5. Phased plan + cross-repo sweep

**Phase order is a2 → a4 → a3 (LOAD-BEARING, critic-ruled):** until a4 wires `normalizeManifest` into
`parsePluginJson` and rewrites the consumers, the host actively REJECTS pure manifests
(`manifest-validation.ts:391-403` string-loop fires first) — so a pure manifest shipped before a4 fails
load silently (0 handlers registered). The same fact makes a2-in-isolation safe (string[]-typed consumers
can never see a `Tool[]`).

| Phase | Scope | Gate |
|---|---|---|
| **a1** | This design doc → maintainer sign-off | agreement (done, §0 — three rounds 2026-07-09) |
| **a2 (SDK v6)** | MCP `Tool` type + `tools: string[] \| Tool[]` `oneOf` schema + `normalizeManifest` compat (legacy → pure form, removed fields dropped with a load-time notice) + the `engines.lvisHost`-style host-compat field | SDK tests; host validator native-field probes updated |
| **a4** | Host: `normalizeManifest` wired into `parsePluginJson` (incl. the :391-403 string-loop rewrite); intra-object auth/visibility checks replace cross-field checks; ALL host readers migrated to the normalized `Tool[]` — `manifestToolsToMcpTools`/`declaredRuntimeMethods`/gate **+ `knownToolOwners` (MODEL-ONLY, §2.4a) + `buildPluginCard`**; `writesToOwnSandbox` verdict input replaced by the host-side containment derivation (self-invalidates the `toolPolicyIdentity` cache); host-compat gate enforced; `readCategory` warn only on present-but-malformed (silent on v6-absent) | full vitest + pre-push |
| **a3** | Migrate 6 first-party manifests + template to the pure form; bump each to SDK v6. **Marketplace publication held until the a4 host is GA** (pre-a4 hosts cannot load pure manifests) | each loads + registers on an a4 host; per-surface SET-equality invariant (model-set == old `tools[]`, app-set == old `uiActions` keys); tsc/vitest green |
| **b1+b2+b3** | Per-server partition + detached viewKey + disconnect teardown (b1 lands with b2 — the `will-attach-webview` allowlist couples them) | Playwright e2e (renderer) + cluster review (touches `src/main`, IPC trust boundary) |
| **b4** | Executor parity regression test + docs (no behavior change) | test asserts mcp==plugin traversal |
| **R (removal)** | Delete legacy `toolSchemas`/`uiActions`/`PluginUiActionSpec` + removed-field plumbing + dormant deprecation machinery + compat branch (§3). **First-party-only assumption:** the removal gate verifies first-party + catalog manifests; a sideloaded third-party LEGACY manifest fails load post-R with the schema's clear reject error (accepted — the ecosystem is first-party at this stage) | removal gate §3.2 green; sweep §3.3 = 0; tsc/vitest/build green |

**Cross-repo sweep (must move in-session per CLAUDE.md §Cross-repo contract sync):**
`lvis-app` (host) · `lvis-plugin-sdk` (v5.22.0 → **v6**) · 6 plugins (`meeting`, `ms-graph`, `work-assistant`,
`local-indexer`, `lge-api`, `git`) · `lvis-plugin-template` · `lvis-marketplace` (catalog
`PluginMarketplaceItem.tools`/`.toolSchemas` mirror + publisher schema).

## 6. Open items (non-blocking)

- `lvis-plugin-work-assistant-briefing-routine` has **no** standalone `plugin.json` (verified) — excluded
  from the migration set.
- b1 lazy per-server CDN-allowlist registration: confirm the `webRequest` filter can be (re)installed for a
  dynamic partition name without leaking a prior server's allowlist.
- a4: the host-side `writesToOwnSandbox` derivation replaces the reviewer input. **Cache-identity RESOLVED
  (verified 2026-07-09):** the flag participated in `toolPolicyIdentity` (`verdict-cache.ts:156`); removing it
  mutates the canonical JSON of every entry → sha256 differs → all old-shape keys are unreachable (mass
  re-classify, no stale HIT). `ownerPluginSandboxRoot` (`:157`) is retained; user-approval memory keyed on
  `finalInput` is untouched. The dead→live auto-LOW flip runs in `RuleBasedRiskClassifier` independently of
  `hostClassifiesRisk`, so it also reaches OFF users — R1 confirms no plugin depends on the own-sandbox-write
  round-trip (census: 0 declarations); ship-as-is, no feature flag (Q4).
- Cluster review is REQUIRED for the (b) phase (sensitive `src/main` + IPC boundary).

## References (file:line + external evidence)

Internal:
- `src/plugins/types.ts:163,201,237-293` — `tools[]`, `uiActions`, `toolSchemas` (the three surfaces).
- `src/plugins/runtime/manifest-validation.ts:494-519,525-548,592-607,629-638` — cross-field checks the pure
  shape replaces.
- `src/plugins/runtime/plugin-loader.ts:28-40` — `declaredUiInvokableMethods`/`declaredRuntimeMethods`.
- `src/boot/plugin-tool-invocation.ts:33-37,84-89` — the #1554/#1556 governed-vs-bypass predicate.
- `src/mcp/plugin-server-projection.ts:141-150,117-125` — forward projection (already-live path).
- `src/mcp/plugin-tool-from-mcp.ts:130-182` — reverse projection (`_meta` → canonical `Tool`).
- `src/boot/steps/plugin-runtime.ts:517-521` + `.../lifecycle.ts:122-130` — loopback is the sole live path.
- `src/permissions/sandbox-capability.ts:237-263` — runtime `(pluginId, workerId)` registration by
  `spawnWorker`'s wrapped-spawn path ("only spawnWorker's wrapped-spawn path calls this") — the real
  worker-binding proof that replaces the manifest `workerId`.
- `src/permissions/permission-manager.ts:1107,1187-1191` — `writesToOwnSandbox` reviewer input to be
  replaced by the host containment derivation.
- Census (2026-07-09, all 6 first-party manifests): `pathFields` 5 declarations (meeting, local-indexer);
  `writesToOwnSandbox`/`workerId`/per-tool `version`/`deprecatedSince`/`replacedBy` **0 declarations**;
  no builtin producer for the deprecation pair.
- `docs/architecture/mcp-alignment-design.md §0,§3.3,§8` — the narrowed full-wire direction + verified
  MCP `Tool` shape.

External:
- MCP tool-annotations trust rule (spec 2025-06-18 server/tools): annotations from untrusted servers MUST
  be treated as untrusted.
- MCP Apps SEP-1865 (`io.modelcontextprotocol/ui`, Stable 2026-01-26): `_meta.ui.visibility:
  Array<"model"|"app">` + normative host enforcement; design rationale explicitly rejects the two-boolean
  shape.
- OpenAI Apps SDK reference: `_meta["openai/widgetAccessible"]`, `_meta["openai/visibility"]` (legacy,
  migrating to `_meta.ui.visibility`), `_meta["openai/fileParams"]` (the `pathFields` structural twin).
- Claude Code permissions/plugins reference: host-side path permission rules; no tool-declared path safety;
  package-level version only.
- Codex CLI: `sandbox_mode`/`writable_roots` host config; issue #7635 (self-attested sandbox field)
  closed not-planned.
- FastMCP `_meta.fastmcp.version` — vendor-extension precedent for any future per-tool metadata.
