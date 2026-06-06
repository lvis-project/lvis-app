# LVIS ⇄ MCP 2026-07-28 RC Alignment — Design

> Status: **Design / approved direction** (decisions §0 ratified by the maintainer 2026-06-06).
> Target revision: MCP `2026-07-28` Release Candidate (stateless protocol, per-request `_meta`,
> `server/discover`, MRTR, + Apps/Tasks/Skills extensions).
> Directive: LVIS plugins implemented **as MCP apps/servers**; **No Fallback Code** — design for the
> correct end-state, no degrade/shim layers.
> Issues: supersedes/absorbs #885 (plugin contract simplification + MCP isolation parity) and frames
> #811 (hook runtime expansion) in an MCP-aligned direction.

> **Wire shapes are verified.** The exact RC field shapes were pinned **verbatim** against the
> authoritative upstream schema — `schema/draft/schema.ts` in the `modelcontextprotocol/modelcontextprotocol`
> repo (`LATEST_PROTOCOL_VERSION = "2026-07-28"`), plus the separate `modelcontextprotocol/experimental-ext-tasks`
> repo for Tasks. The pinned shapes are in **§8** and supersede the earlier prose summary (which had several
> errors — see §8's correction list). `schema/draft/schema.ts` referenced below always means that **upstream**
> file, not an in-repo path.

---

## 0. Ratified decisions

| # | Decision | Choice |
|---|---|---|
| Topology | How plugins run as MCP servers | **Hybrid** — out-of-process **stdio** for marketplace/untrusted plugins (real OS isolation, layer LVIS's existing bubblewrap/sandbox-exec); **in-process loopback** for first-party/trusted plugins (perf, signed-zip `entry`/factory artifact unchanged). |
| HostApi | What replaces the host-call surface | **No "Host Services MCP server."** The remaining HostApi maps onto **standard MCP client-features** the host advertises per-request (`sampling` for `callLlm`, `elicitation` for approvals), **MCP authorization** (OAuth) for secrets, **MCP Apps** for UI; LVIS-only surfaces (storage/config/triggerConversation/event bus) stay **host-internal**. Audit & remove any already-moved-out leftovers. |
| External MCP servers | Old-revision external server compat | **Documented dual-era exception in `mcp-client.ts` only** — probe `server/discover`, fall back to `initialize` for pre-RC external servers. LVIS's **own** plugins are always RC (no fallback). This is the one explicit, documented exception to No-Fallback, scoped to external interop. |
| Event bus | Fate of `${id}.verb.noun` + cross-plugin grants | **Hybrid** — `tools`/`resources` **list-change** surfaced via MCP-standard notifications (ecosystem interop); LVIS-only **domain events** (`${id}.verb.noun`) and the audited **cross-plugin event-grant** model (`pluginAccess.plugins[].events`, `assertPluginEventAccess`/`assertPluginEventEmitAccess`) stay **host-internal** (MCP has no plugin↔plugin pub/sub; dropping it would delete the proactive architecture + a security-governed feature). |

**Correction to the research:** `HostApi.addTask`/`saveNote` are **already removed** from the app (they were moved plugin-side) — they are not live surfaces and need no MCP home. The live HostApi surface is the generic set in §3.5.

---

## 1. Executive summary

The **LVIS host becomes an MCP _host_** that runs **one MCP client per loaded plugin**, and **each plugin is an MCP _server_** speaking the stateless `2026-07-28` protocol. Marketplace/untrusted plugins run **out-of-process over stdio** (a normal MCP server); first-party plugins run **in-process behind a loopback transport** (today's `entry`/factory model, MCP-framed). The plugin's `plugin.json` projects to `server/discover`'s `DiscoverResult` (serverInfo + capabilities + `extensions`). `toolSchemas[*]` project to MCP `Tool`s; LVIS's `read|write|shell|network` **category stays the authoritative policy SOT** carried under reverse-DNS `_meta["xyz.lvis/category"]`, projected to (untrusted, interop-only) MCP `ToolAnnotations`. The host caches **nothing** on the connection: every host→plugin request carries `protocolVersion`+`clientInfo`+`clientCapabilities` in `_meta`, and every result is wrapped with a `resultType` discriminator. The remaining HostApi maps onto **standard MCP client-features** (sampling/elicitation), **MCP authorization**, and **MCP Apps** — **no bespoke host server**; LVIS-only platform surfaces (storage, config, triggerConversation, the domain event bus) stay host-internal. **#811 command-hooks stay 100% host-side** — MCP has no host-side tool-call veto, so hooks remain a host policy layer wrapped around the host's `tools/call` invocation, re-anchored to that boundary.

---

## 2. Divergence map

| LVIS element | MCP `2026-07-28` equivalent | Required change |
|---|---|---|
| `PluginManifest` (id/name/version/entry/tools[]/description) (`src/plugins/types.ts:175`) | `DiscoverResult` { supportedVersions, serverInfo:Implementation, capabilities, instructions? } | Manifest is a static file; MCP needs a live `server/discover` handler. Add manifest→`DiscoverResult` projection. `entry` becomes the server process (stdio) or loopback module. |
| `toolSchemas[name]` (inputSchema **draft-07** + category/pathFields/writesToOwnSandbox/version/deprecatedSince/replacedBy) (`src/plugins/types.ts:268-306`) | `Tool` { name, title?, description?, inputSchema(**2020-12**, type:object), outputSchema?, annotations?, icons?, _meta? } via `tools/list`; `tools/call`→`CallToolResult{content[],structuredContent?,isError?}` | (a) dialect draft-07 → 2020-12. (b) category/pathFields/writesToOwnSandbox/version/deprecatedSince/replacedBy → `_meta["xyz.lvis/*"]` (reverse-DNS; second label MUST NOT be `mcp`/`modelcontextprotocol`). (c) project category → `ToolAnnotations` hints (interop only). |
| `PluginHostApi` (generic surface: storage/config/callLlm/resolveApiKey/agentApproval/openAuthWindow/triggerConversation/showOverlay/events/registerKeywords/getInstalledPluginIds/callTool/getSecret) (`src/plugins/types.ts:757-1105`) | **Split** (no single equivalent; **no host server** — §0) | See §3.5. callLlm→**sampling**; agentApproval/asks→**elicitation**; openAuthWindow/secrets→**authorization** (OAuth) + url-elicitation; showOverlay→**Apps**; storage/config/triggerConversation/events→**host-internal**. |
| Plugin domain events `${id}.verb.noun` + `pluginAccess.plugins[].events` grants + `assertPluginEventAccess`/`EmitAccess` (`src/plugins/runtime/index.ts:1723-1749`) | **No MCP equivalent** (MCP notifications are server→host list-change/resource-update only; no plugin↔plugin pub/sub) | **Keep host-internal** (§0 hybrid). Surface only `tools`/`resources` list-change via MCP `notifications/*/list_changed`. |
| Permission categories `read\|write\|shell\|network` (authoritative SOT) (`src/plugins/types.ts:18`) | `ToolAnnotations` (hints, explicitly **untrusted**) + host obtains explicit consent before any `tools/call` | Category stays the authoritative `_meta` SOT; **host policy MUST NOT trust inbound annotations** for permission decisions (matches MCP's own "annotations untrusted unless trusted server"). |
| Hooks (Layer-6 shell pre/post/perm, deny-only, TOFU lockfile) (`src/hooks/*`, fire points `src/tools/executor.ts:1736/1833/1991`) | **No equivalent** (MCP has no host-side tool-call veto) | Remain a pure host policy layer; re-anchor fire points to the host's `tools/call` boundary (§4). |
| MCP client (pins `2024-11-05`, empty `capabilities:{}` `initialize`, no `resultType`) (`src/mcp/mcp-client.ts:116,80-110`) | Stateless `2026-07-28`: no `initialize`; per-request `_meta`; `server/discover`; `resultType`; MRTR; `subscriptions/listen` | Rewrite handshake → stateless request builder + `server/discover` + `resultType` branch + MRTR loop + error mapping + HTTP headers. **Dual-era exception** (§0) only for external servers. |
| `McpServerApproval.allowedCapabilities` (static per-connection whitelist) (`src/mcp/types.ts:27-97`) | Per-request `clientCapabilities` in `_meta`; server returns missing-capability error | Governance moves from connect-time whitelist → per-request capability declaration + per-request gating; **policy** (deny-by-default, namespace, max-tools) stays host-side. |
| Long-running routines (host-internal) | **Tasks** extension `io.modelcontextprotocol/tasks` | New: long-running plugin tools opt into Tasks; host polls. _(verify exact Tasks methods — research found conflicting names.)_ |
| Plugin UI (`PluginUiExtension[]`, detached BrowserWindow) (`src/plugins/types.ts:189`) | **MCP Apps** `io.modelcontextprotocol/ui` (`_meta.ui`→`ui://` resource, `text/html;profile=mcp-app`) | Electron host uses the native-host iframe path under a host-built CSP. **Apps version axis is SEPARATE** (SEP-1865 / snapshot `2026-01-26`, postMessage `2025-06-18`) — do not couple to the core-RC milestone. |
| Skills (`SkillOverlay`, `SKILL.md`+`references/`) (`src/main/skill-overlay.ts`) | **Skills over MCP** `io.modelcontextprotocol/skills` (skills as `skill://` Resources) | Maps cleanly (no new RPC); **SEP-2640 is Draft** — pin schema before building; never auto-execute skill-declared code without per-skill opt-in. |

**GAPS now resolved (see §8 for the verified shapes):** Tasks lives in a **separate** extension repo (`experimental-ext-tasks`) with methods `tasks/get`/`tasks/update`/`tasks/cancel`; `DiscoverResult.ttlMs`/`cacheScope` are **real required** fields (`CacheableResult`); `resultType` core enum is `"complete" | "input_required"` (`"task"` is extension-only); MRTR retries the **same** request with `inputResponses`+echoed `requestState` (no new id); errors are `-32003` (missing client capability) / `-32004` (unsupported version) — **no "input-required error"**; there is **no `subscriptionId` `_meta` key**; `sampling`/`roots`/`logging` are **deprecated** (SEP-2577). Still genuinely open: **MCP Apps** is not a `2026-07-28` artifact (SEP-1865, snapshot `2026-01-26`) and **Skills** SEP-2640 is Draft — both pinned at their own milestone.

---

## 3. Target architecture

### 3.1 Topology (hybrid)

```
 LVIS Host (MCP host)
 ├─ ConversationLoop / ToolRegistry / ToolExecutor      (role unchanged; now MCP-fed)
 ├─ Per-plugin MCP CLIENT ─stateless 2026-07-28─► Plugin = MCP SERVER
 │     • marketplace/untrusted → out-of-process stdio subprocess (+ bubblewrap/sandbox-exec)
 │     • first-party/trusted   → in-process loopback transport (today's entry/factory)
 ├─ Host MCP client-features  (sampling, elicitation, authorization, Apps) advertised per-request
 ├─ Host-internal platform     (storage, config, triggerConversation, DOMAIN EVENT BUS + grants)
 └─ Governance + #811 Hooks    (host policy WRAPPING the client's tools/call)
```

1:1 client↔server per plugin (per the RC). The connection is **not** a session — nothing about version/capabilities/identity is cached on it. The "first-party vs untrusted" split is the existing trust signal (signed-zip marketplace install vs first-party bundle); it MUST be an enforced boundary, not advisory.

### 3.2 Manifest → `DiscoverResult`

`server/discover` projects the manifest: `serverInfo` from name/version/description/icon; `supportedVersions:["2026-07-28"]`; `capabilities.{tools,resources,prompts}` from what the plugin contributes, plus an `extensions` map (`io.modelcontextprotocol/tasks`, `…/ui`, `…/skills`) gated on actual plugin content. The advisory `manifest.capabilities[]` kebab list (`meeting-recorder`, …) is **LVIS-internal dependency metadata, not MCP `ServerCapabilities`** — keep it out of the MCP capability map (carry under `_meta` if it must travel).

### 3.3 `toolSchemas` → `Tool`

- `name` keeps the existing underscore LLM tool name. `inputSchema` migrates draft-07 → 2020-12.
- **Category stays the SOT** under `_meta["xyz.lvis/category"]`; project to `ToolAnnotations` (`readOnlyHint`/`destructiveHint`/`openWorldHint`) for interop only — host policy reads `_meta`, never inbound annotations.
- `pathFields`/`writesToOwnSandbox`/`version`/`deprecatedSince`/`replacedBy` → `_meta["xyz.lvis/*"]`.
- `tools/call`→`CallToolResult{content[],structuredContent?,isError?}` wrapped `resultType:"complete"`; tool failures use `isError:true` (not JSON-RPC errors) — matches LVIS's executor result model.
- **No-Fallback field-sweep:** `toolSchemas` entries are `additionalProperties:false` (M4 fixture contract). Adding `outputSchema`/`_meta` carriers means SDK schema + host validator + fixtures move in **one PR** (repo field-addition-sweep + No-Fallback rules).

### 3.4 Events (hybrid)

- **List-change** (`tools`/`resources`/`prompts` set changed) → MCP `notifications/*/list_changed` via `subscriptions/listen` opt-in (ecosystem interop).
- **LVIS domain events** (`${id}.verb.noun`) + **cross-plugin grants** (`pluginAccess.plugins[].events`, `assertPluginEventAccess`/`EmitAccess`) → **stay host-internal**, outside MCP conformance. This preserves the proactive architecture (e.g. work-assistant reacting to `email.action.needed`/`meeting.summary.created`) and the audited cross-plugin event-grant security model, which MCP cannot express (no plugin↔plugin pub/sub). Plugins reach the bus via the host-internal HostApi surface, exactly as today.

### 3.5 HostApi → MCP (no host server)

| Live HostApi surface | Target |
|---|---|
| `callLlm`, `resolveApiKey` (LLM access) | **`sampling` is deprecated in the RC (SEP-2577)** — so keep LLM access **host-internal**, surfaced through the per-request capability model (the plugin-server signals need via MRTR `input_required`; the host runs the LLM and retries). Do **not** build on the deprecated `sampling/createMessage` primitive. |
| `agentApproval`, permission asks | host's **`elicitation`** client-capability (MRTR `elicitation/create`; form mode = approve/deny/dismiss) |
| `openAuthWindow`, `getSecret` | **MCP authorization** (OAuth 2.1 + PKCE + RFC 8707) for HTTP plugins; env-injected creds for stdio plugins; `url`-mode elicitation drives interactive consent |
| `showOverlay`, UI | **MCP Apps** (`_meta.ui.resourceUri`→`ui://` resource) |
| `storage`, `config` | **host-internal** (MCP is stateless — no config/storage RPC). Storage stays the sandboxed per-plugin data dir via `createPluginStorage(pluginId, pluginDataDir)` rooted at `<pluginsRoot>/<pluginId>/data/` (`src/plugins/runtime/sandbox.ts`); this is the plugin path, distinct from `openFeatureNamespace`'s single-segment `~/.lvis/<featureId>/` host namespaces. |
| `triggerConversation`, `registerKeywords`, `getInstalledPluginIds`, `onPluginsChanged`, `callTool`, event bus | **host-internal** platform surfaces (no MCP primitive); `logEvent` ≈ `notifications/message` |

The host, as MCP host, advertises `sampling`/`elicitation` as per-request `clientCapabilities` — **that is the standard path** for a plugin-server to "call back" to the host. No bespoke server.

### 3.6 Stateless per-request `_meta`

Every host→plugin request `params._meta` carries `protocolVersion`, `clientInfo`, and `clientCapabilities` _(exact reserved key strings + value shapes pinned in §7)_. The host's per-request capability set is **derived from #811 policy + the active turn's consent state** (e.g. a headless routine omits `elicitation`; a plugin needing it then surfaces the missing-capability error), not hardcoded — this is the integration seam between governance, #811, and the MCP client. HTTP plugins also set the RC's required HTTP headers and bind localhost with `Origin` validation. Results branch on `resultType`: `complete` (parse `CallToolResult`), `input_required` (run MRTR), `task` (Tasks). LVIS's own plugins always emit `resultType` (No-Fallback); the **absent-`resultType` legacy branch exists only inside the dual-era external-server exception**.

### 3.7 UI → MCP Apps

Tool sets `_meta.ui.resourceUri:"ui://<plugin>/<view>"`; host `resources/read` fetches `text/html;profile=mcp-app` and renders it in a sandboxed iframe under a host-built CSP from `_meta.ui` (native-host iframe path — LVIS is Electron, so no double-iframe Sandbox Proxy). Drive `ui/initialize`→`ui/notifications/initialized`→`tool-input`/`tool-result`; gate `ui/open-link`/`ui/download-file`/`ui/request-display-mode` with host consent. **Apps version axis is independent** of the core RC.

---

## 4. Where #811 command hooks fit

**MCP has no host-side tool-call hook/veto primitive** (elicitation is server-initiated, not a host policy gate). So **hooks remain entirely a LVIS-host concern, layered around the host's MCP `tools/call`.** The #811 hook-runtime-expansion design (`docs/architecture/hook-runtime-expansion-design.md`) is fully compatible — only fire-point anchoring changes:

| #811 element | MCP-aligned anchoring |
|---|---|
| `PreToolUse` (blocking) | fires in the host **before the client emits `tools/call`** to the plugin-server |
| `PermissionRequest` | unchanged host gate; **distinct** from any MRTR `elicitation` the *plugin* later requests |
| `PostToolUse` (informational) | observes the `CallToolResult` returned by the plugin-server |
| `ScriptHookStdin.source`/`category` | `source` = plugin-via-MCP; `category` read from the tool's authoritative `_meta["xyz.lvis/category"]`; add plugin-server identity + per-request protocol version so hooks can policy on it |
| deny | host **declines to send `tools/call`** / aborts MRTR retry — still a host veto, never an MCP message |
| TOFU lockfile / quarantine / `/permission hooks accept` | unchanged (pure host trust model) |
| future generic hooks + `mcp__.*` matcher | the matcher matches the host's `tools/call` by tool name; an "MCP-handler hook" is itself a host policy MCP client — a clean fit, but a *host policy server*, not a protocol veto |

DLP redaction now redacts the `tools/call` `arguments` before the hook sees them (same intent). A future `modify` action (deferred to hook-signing) rewrites the **`tools/call` params**, not a closure's args — same threat model, MCP-shaped surface.

---

## 5. No-fallback migration milestones (behavior-named)

Ordered; each *change → unblocks → gate*. Because each plugin gets its own client, RC-server plugins and (interim) legacy plugins coexist **internally** during migration — most milestones land without a flag-day.

1. **`stateless-client-rebuild`** — rewrite `src/mcp/mcp-client.ts` to the RC stateless envelope: drop `initialize`/empty-capabilities; bump `MCP_PROTOCOL_VERSION`→`"2026-07-28"`; stamp the three `_meta` keys on every request; add `server/discover`; add the `resultType` branch; add the missing-capability/input-required error mapping; add HTTP headers. **Carries the documented dual-era exception** (probe `server/discover`, fall back to `initialize`) for external servers only. *Gate:* conformance fixture server (golden discover + list + call w/ `resultType`); existing external-MCP e2e green; implemented against the verified §8 shapes.
2. **`mrtr-input-loop`** — client MRTR loop: on `input_required`, gather `inputRequests` (elicitation via approval gate, sampling via host LLM), retry with a new id, echo `requestState` verbatim. *Gate:* MRTR fixture (form + url elicitation, new-id + opacity assertions).
3. **`plugin-loopback-server`** — define the in-process loopback transport + the stdio transport; project `PluginManifest`/`toolSchemas` → `server/discover`+`tools/list`+`tools/call`; run **one first-party plugin** as a loopback MCP server behind a per-plugin client; route `ToolRegistry` registration through MCP discovery instead of `pluginToolsForRegistration`; dialect draft-07→2020-12; category/etc. in `_meta`. *Gate:* SDK schema + validator + fixtures in **one PR** (No-Fallback); migrated plugin passes the full permission pipeline identically (category SOT from `_meta`).
4. **`untrusted-stdio-isolation`** — out-of-process stdio runtime for marketplace plugins (+ bubblewrap/sandbox-exec), spawn/lifecycle, the spawnable-server artifact format. *Gate:* a marketplace plugin runs isolated; crash/hang containment test; artifact re-sign + installed-plugin migration path.
5. **`governance-per-request`** — move governance from static `allowedCapabilities` whitelist to per-request capability declaration + per-request gating; keep deny-by-default, namespace, max-tools. *Gate:* **cluster review** (permissions area triggers CLAUDE.md §Cross-Cutting Review Gate — budget for it).
6. **`hooks-on-mcp-calls`** (#811 continuation) — re-anchor `PreToolUse`/`PermissionRequest`/`PostToolUse` to the host's `tools/call`; hook stdin reads `_meta["xyz.lvis/category"]` + per-request identity; add the `mcp__.*` matcher; then continue the #811 generic-command-hooks milestone in this frame. *Gate:* deny still blocks the call; fail-closed preserved; audit HMAC chain intact.
7. **`tasks-extension`** — adopt `io.modelcontextprotocol/tasks` for long-running plugin tools (verified: separate `experimental-ext-tasks` repo; `tasks/get`/`tasks/update`/`tasks/cancel`; `notifications/tasks` carries the full `DetailedTask`; `CreateTaskResult` sets `resultType:"task"`). *Gate:* pin the extension's draft schema at the milestone (it versions independently of the core RC); durable task store survives restart.
8. **`apps-and-skills-extensions`** — `io.modelcontextprotocol/ui` (Apps; native-host iframe) and `io.modelcontextprotocol/skills` (skills as `skill://` Resources). *Gate:* CSP/permission enforcement per `_meta.ui`; skill digest verification; per-skill opt-in before any skill-declared code execution. Treat Apps/Skills version axes as independent of the core RC.
9. **`legacy-removal`** — delete the now-unused HostApi surfaces replaced by MCP primitives and the `2024-11-05` client path (keep only the documented external dual-era exception). *Gate:* grep-clean of removed surfaces; all first-party plugins migrated; artifact format finalized.

**Hard cutover (unavoidable):** `legacy-removal` is a flag-day gated on all first-party plugins migrated + the signed-zip format updated. External-server compat is preserved by the dual-era exception (no flag-day for external).

---

## 6. Remaining open decisions (lower-priority; can be decided at the milestone)

- **Signed-zip artifact format** — out-of-process stdio + new manifest/`_meta` fields version the artifact + SDK schema; define the re-sign + installed-plugin migration (`plugin-install-receipt.ts` SHA-256 pins). Decide at `untrusted-stdio-isolation`.
- **Tasks extension draft pinning** — `experimental-ext-tasks` versions independently of the core RC; pin its draft schema (and re-check `DetailedTask`/`notifications/tasks`) at `tasks-extension`.
- **Apps/Skills version pinning** — pin to the `2026-01-26`/Draft snapshots now (accept churn) or defer until they ride a dated RC. Decide at `apps-and-skills-extensions`.
- **Per-request capability source** — the exact signals (turn consent state, headless/routine mode, #811 policy) that derive the host's per-request `clientCapabilities`. Decide at `mrtr-input-loop`/`governance-per-request`.

---

## 7. First implementable slice

**PR: "MCP RC stateless request envelope + `server/discover` + `resultType` (+ documented dual-era exception), behind a conformance fixture."** = milestone `stateless-client-rebuild`.

- **Scope (host-as-client only; no plugin/manifest changes; no flag-day):** in `src/mcp/mcp-client.ts`, add `buildRequestMeta()` stamping the three reserved `_meta` keys on **every** outbound request; add `discover()` (issue `server/discover`, parse `DiscoverResult`); add `parseResult()` reading the `resultType` discriminator (`complete` vs `input_required`/`task`) + typed error mapping; keep `complete` `tools/call` semantics identical so the `mcpToolToTool` adapter (`src/mcp/mcp-tool-adapter.ts`) is untouched. Update the handshake types; bump `MCP_PROTOCOL_VERSION`. Add the **documented dual-era exception** for external servers (probe discover → fall back to `initialize`).
- **Honest under No-Fallback:** `input_required`/`task` return a typed "not-yet-supported" host **error** (real error, not silent fallback) — this slice does not pretend to implement MRTR/Tasks.
- **Why it's also the right #811 substrate:** it establishes the per-request `_meta` identity object the MCP-aligned hooks policy on, and the `resultType` branch point where `PreToolUse`/MRTR interception later plugs in.
- **Gate (CLAUDE.md):** new conformance fixture server (golden `server/discover`, `tools/list`, `tools/call`→`resultType:"complete"`) under vitest; `mcp-governance.test.ts` updated for per-request `_meta` presence; existing MCP e2e green; **no renderer change ⇒ Playwright-exempt**; `src/mcp` is **not** a cluster-sensitive dir. **Implement against the verified §8 shapes** (already pinned to the upstream `schema/draft/schema.ts` — do not re-derive from prose).
- **Out of this PR:** no manifest/SDK schema field additions (those land lockstep at `plugin-loopback-server`); no HostApi changes; no MRTR/Tasks/Apps execution.

---

## 8. Verified RC wire shapes (pinned to upstream `schema/draft/schema.ts`)

Quoted/condensed from `modelcontextprotocol/modelcontextprotocol@main schema/draft/schema.ts`
(`LATEST_PROTOCOL_VERSION = "2026-07-28"`) and `modelcontextprotocol/experimental-ext-tasks` (Tasks).

**Per-request `_meta` (REQUIRED on every request — `RequestParams._meta` is required):**
```ts
RequestMetaObject {
  progressToken?: ProgressToken;
  "io.modelcontextprotocol/protocolVersion": string;          // required
  "io.modelcontextprotocol/clientInfo": Implementation;        // required  {name, version, title?, description?, icons?, websiteUrl?}
  "io.modelcontextprotocol/clientCapabilities": ClientCapabilities; // required
  "io.modelcontextprotocol/logLevel"?: LoggingLevel;           // optional, @deprecated SEP-2577
}
```

**Result envelope:** `Result { _meta?; resultType: "complete" | "input_required" | string; … }` — servers on this version MUST include `resultType`; absent ⇒ treat as `"complete"`. Tool response is the union `CallToolResult | InputRequiredResult` (same for resources/prompts).

**`server/discover`** (server MUST implement; client MAY call): `DiscoverResult extends CacheableResult` with **required** `ttlMs: number`, `cacheScope: "public"|"private"`, `supportedVersions: string[]`, `capabilities: ServerCapabilities`, `serverInfo: Implementation`, optional `instructions`. No `cacheKey`.

**MRTR:** `InputRequiredResult { inputRequests?: {[id]: CreateMessage|ListRoots|Elicit}; requestState?: string }` (≥1 of the two present). Client retries the **same** original request with params `{ inputResponses?: {[id]: …}; requestState? (echoed verbatim, opaque) }`. **No new request id required.**

**Elicitation** `elicitation/create`: form `{mode?:"form", message, requestedSchema}` or url `{mode:"url", message, elicitationId, url}` → `ElicitResult { action: "accept"|"decline"|"cancel"; content? }`.

**Errors:** `-32003` `MISSING_REQUIRED_CLIENT_CAPABILITY` (`data.requiredCapabilities`; HTTP 400); `-32004` `UNSUPPORTED_PROTOCOL_VERSION` (`data.{supported,requested}`). **No "input-required" error code** — input-required is a success `resultType`. Method gated behind an unadvertised *server* capability ⇒ `-32601`.

**Capabilities:** `ClientCapabilities { experimental?; roots?(dep); sampling?(dep); elicitation?{form?,url?}; extensions? }`; `ServerCapabilities { experimental?; logging?(dep); completions?; prompts?{listChanged?}; resources?{subscribe?,listChanged?}; tools?{listChanged?}; extensions? }`. `extensions` keys MUST be prefixed (e.g. `"io.modelcontextprotocol/tasks"`).

**`subscriptions/listen`** params `{ notifications: SubscriptionFilter{ toolsListChanged?, promptsListChanged?, resourcesListChanged?, resourceSubscriptions?: string[] } }`; server first sends `notifications/subscriptions/acknowledged`. Updates: `notifications/resources/updated {uri}`, `notifications/{tools,prompts,resources}/list_changed`. **No `subscriptionId` `_meta` key exists.**

**Tool:** `{ name, title?, icons?, description?, inputSchema:{type:"object", $schema?}, outputSchema?, annotations?:ToolAnnotations, _meta? }`. **JSON Schema dialect = 2020-12** (default when no `$schema`). `ToolAnnotations { title?; readOnlyHint?=false; destructiveHint?=true; idempotentHint?=false; openWorldHint?=true }`.

**`_meta` namespacing:** prefix = dot-separated labels + `/`; reverse-DNS recommended; **any prefix whose second label is `mcp` or `modelcontextprotocol` is RESERVED for MCP** (so LVIS uses e.g. `xyz.lvis/…`, never `*.mcp/…`).

**Tasks (`experimental-ext-tasks`):** methods `tasks/get` / `tasks/update {taskId, inputResponses}` / `tasks/cancel {taskId}`; `CreateTaskResult = Result & Task` with `resultType:"task"`; `Task {taskId, status: "working"|"input_required"|"completed"|"failed"|"cancelled", createdAt, lastUpdatedAt, ttlMs|null, pollIntervalMs?}`; `notifications/tasks` carries the full `DetailedTask`; subscribe via `subscriptions/listen` + `{taskIds}`.

**Corrections vs the earlier prose research:** `-32003`/`-32004` meanings (were swapped); no input-required error path; no `subscriptionId` key; Tasks methods are `get/update/cancel` (not `tasks/result`) and live in a separate repo; `"task"` resultType is extension-only; `ttlMs`/`cacheScope` are required; `sampling`/`roots`/`logging` deprecated (SEP-2577).

---

### Key file refs
- `src/mcp/mcp-client.ts` (handshake, `MCP_PROTOCOL_VERSION:116`, `McpInitializeResult:80`, `McpToolCallResult._meta.ui:97`), `src/mcp/mcp-tool-adapter.ts` (`mcpToolToTool`), `src/mcp/types.ts` (`McpServerApproval.allowedCapabilities:27-97`)
- `src/plugins/types.ts` (`PluginManifest:175`, `toolSchemas:268-306`, `PluginHostApi:757-1105`, `PluginToolCategory:18`)
- `src/plugins/runtime/index.ts` (`assertPluginEventAccess:1723`, `assertPluginEventEmitAccess:1738`, `inferEventOwner`)
- `src/hooks/script-hook-types.ts` (`ScriptHookStdin`, `ScriptHookStdout`, `modify` forbidden), `src/tools/executor.ts` (hook fire points `1736/1833/1991`)
- `docs/architecture/hook-runtime-expansion-design.md` (#811)
