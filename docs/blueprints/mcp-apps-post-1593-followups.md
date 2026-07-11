# MCP Apps — What #1593 Unlocked (Assessment, and What Shipped)

- Status: **Assessment CLOSED — every item below landed in PR #1600.** Kept as the decision record: it is why the #1600 work exists, and it carries one correction that changed the plan mid-flight (see *Correction*).
- Forward-looking SoT for plugin authors is **not this file** — it is `docs/guides/mcp-app-authoring.md`. Read that to build an app; read this to understand why the host looks the way it does.
- Trigger: PR #1593 (`02efcb87`) replaced the dead hand-rolled MCP-Apps bridge with the upstream `@modelcontextprotocol/ext-apps` `AppBridge` over a host-owned sandbox-proxy transport. This doc answered: *now that the bridge landed, what can we improve on the app and plugin side that we could not before?*
- Not in scope: improving #1593 itself. #1593 is merged, CI-green, cluster-passed. The two security items flagged during survey were independently re-verified against the shipping code and are **non-issues** (see Appendix A).

## Correction (2026-07-12) — the pipeline was NOT end-to-end for plugins

The original TL;DR claimed the render path was "live end-to-end today: a plugin tool that returns `_meta.ui.resourceUri` gets its `ui://` HTML rendered." **That was true only for EXTERNAL MCP servers.** Building against it exposed two breaks on the first-party plugin arm:

1. **No `ui://` serving.** `readUiResource` resolved the uri against `mcpManager.clients` — the external-server map. A plugin is not in that map, so a plugin's `ui://` uri resolved to nothing. There was no plugin-side serving path at all.
2. **No card trigger.** `pluginRuntimeToolDelegate` never lifted a handler's `_meta.ui` onto the wire result, so even a plugin that *wanted* a card could not ask for one.

So the honest framing is: #1593 delivered the **host render surface**; the **plugin arm of the pipeline did not exist**. PR #1600 built it (PR-B1 serving seam + the `_meta.ui` lift), which is why the plugin story below reads as "wire a handler" but shipped as "build the arm."

The claim it *did* get right, and the one that drove sequencing: **zero plugins shipped a `ui://` app** (verified by grep across all 7 plugin repos + `@lvis/plugin-sdk`). #1593 delivered a capability, not yet value.

## What shipped (PR #1600)

| Assessment item | Shipped as |
|---|---|
| P0 — populate `HostContext` | theme / locale / timeZone / displayMode / availableDisplayModes, with `--lvis-*` tokens mapped to the **standard** `McpUiStyleVariableKey` vocabulary (zero proprietary keys leak) |
| P1 — `onsizechange`, `onopenlink` | wired, plus the **handlers-table seam**: one array in `mcp-app-bridge.ts` from which BOTH the advertised capabilities and the registrations derive, so a capability cannot be advertised without its handler |
| P1 — `oncalltool` | gated IPC through `callFromUi` → the same `inspectHostRisk` executor gate a model call takes, plus the spec's **MUST** visibility check (`_meta.ui.visibility ∋ "app"`) that neither the SDK nor the reference host implements |
| P1 — `onsendmessage` | shipped as `onmessage` (the assessment used the wrong handler name — see *Handler names are load-bearing*): notification path + **user-gated** conversation injection with `app-emitted` provenance |
| P1 — `onrequestdisplaymode` | `inline` / `fullscreen` on the existing detach seam. `pip` deliberately NOT advertised (it needs a second always-on-top window stack) |
| P2 — CSP + permissions authoring | `docs/guides/mcp-app-authoring.md` |
| (found while building) | `ondownloadfile`, `onupdatemodelcontext`, and the plugin `ui://` serving arm above |

### Handler names are load-bearing

This assessment named the chat handler `onsendmessage`. The real ext-apps name is **`onmessage`**; `onsizechanged` is really **`onsizechange`**. Assigning the wrong name on an `AppBridge` is a **silent no-op** — no type error, no runtime error, the app's call simply never arrives. Every handler name in #1600 is pinned by a test for exactly this reason.

## The unlock model (what the bridge made possible)

```
plugin tool result  _meta.ui.resourceUri (nested, stable-spec form)
   → plugin-runtime-delegate.ts  lifts _meta.ui onto the wire result  ← BUILT IN #1600
   → McpUiPayload
   → McpAppView               renders <webview> on per-server partition
   → readUiResource IPC       resolves loopback-first, then external    ← UNIFIED IN #1600
   → plugin-ui-resource-provider  declared-only policy gate → plugin serves bytes  ← BUILT IN #1600
   → main mints proxy session + per-resource CSP header
   → sandbox-proxy document    host-owned, script-free (mcp-app-protocol.ts)
   → relay preload             mounts inner <iframe sandbox="allow-scripts" srcdoc>
   → AppBridge ⇄ WebviewIpcTransport ⇄ webview ipc ⇄ preload ⇄ inner App
```

The **App** object inside the inner frame is the upstream ext-apps `App` — it already *speaks* the full View SDK (`callServerTool`, `sendSizeChanged`, `openLink`, `requestDisplayMode`, `onhostcontextchanged`, …). Each of those calls lands on an `AppBridge` handler. Before #1600 only `onreadresource` was registered; now the whole surface is.

## Design decisions worth remembering

- **The handlers table is the SoT.** Adding a handler = one table entry + one module under `mcp-app-bridge/handlers/`. The capability object is `reduce`d from the same array that registers, so the two cannot drift. This is the extensible seam the owner asked for, with no gating layers to debug through.
- **Locked (owner, 2026-07-11): a plugin converts to an MCP App by using `@modelcontextprotocol/ext-apps` DIRECTLY.** No `@lvis/plugin-sdk` UI helper. This keeps the SDK a thin types+contract mirror (consistent with the v7 UI removal) and avoids re-growing the surface we just cut. The MCP library *is* the plugin-author contract for app UIs.
- **"Declared policy, served content."** The manifest declares a `ui://` uri plus its `csp`/`permissions`; the plugin serves the bytes from `RuntimePlugin.readUiResource(uri)`. The host never resolves a plugin-declared disk path. This is what let #1600 **delete** the realpath/containment layer an earlier draft needed: the containment existed only because the host was reading untrusted paths. Remove the reason, remove the layer.
- **An app-initiated tool call is not more trusted than a model-initiated one.** `oncalltool` binds `serverId` from the trusted payload (an app never names a server), rejects cross-server calls, enforces the spec visibility gate, and runs the same risk classifier. `userAction` is always `false` — a gesture claim from inside an untrusted iframe is unverifiable.
- **An app cannot wake the model.** `onmessage` with an active turn goes to the guidance queue (whose atomic check *is* the policy); with no turn in flight it raises a **user-gated card** — the user clicks to send. This matches the references: VS Code fills the chat input without auto-sending, and OpenAI requires a synchronous user gesture. `onupdatemodelcontext` is an overwrite slot read at the *next* turn build, never a wake-up.

## Strategic thread — two webview surfaces, one context model

There are two plugin-facing webview surfaces:

1. **Plugin panel webviews** (`plugin-ui-host.tsx`, `plugin-ui-shell.html`) — get *only the shared font stack* (`DESIGN.md:117–120`). The `DESIGN.md:226/227` theme/locale open questions are about **this** surface.
2. **MCP App `ui://` webviews** (`McpAppView` + `AppBridge`) — where `HostContext` is now the native, standardized theme/locale channel.

P0 gave surface #2 an upstream-blessed theme/locale story, which answers `DESIGN.md:226` ("keep the full `--lvis-*` dump or narrow to a semantic signal?") by adopting the standard `McpUiStyleVariableKey` vocabulary. That reframes the surface-#1 questions from *"design a bespoke signal"* to a strategic choice: **do panel webviews adopt the same `HostContext` model, or keep their own `host.theme.changed` event?** Recommendation unchanged: treat #1600 as the reference implementation, then decide convergence — do not design a second, different theme/locale signal for panels in parallel.

## Non-goals / guardrails (still binding)

- Do not weaken the sandbox to add features. Every handler runs host-side; none touch the inner frame's `allow-scripts`-only sandbox or the main-computed CSP.
- Do not re-grow the SDK UI surface. Plugins use `@modelcontextprotocol/ext-apps` directly; DX is example + docs.
- App-Provided Tools (draft-spec: apps registering their own tools back to the model) is **upstream-draft, not stable** — track it, do not build against it yet.

## Appendix A — security re-verification (independent, against shipping code)

Two items were flagged during the ext-apps survey; both checked against merged `02efcb87` and found to be non-issues:

1. **"Does the host assume a non-existent SDK `SandboxProxyTransport` class?"** — No. `webview-ipc-transport.ts` implements the generic SDK `Transport` interface (`WebviewIpcTransport`) precisely because `PostMessageTransport` cannot work for a `<webview>` (no usable `contentWindow`). Correct DIY, documented in-file.
2. **"Did the untrusted inner View iframe get `allow-same-origin`?"** — No. `INNER_SANDBOX_ATTR = "allow-scripts"` (`mcp-app-bridge-contract.ts:40`), set **unconditionally host-owned** in `createInnerAppFrame` (`mcp-app-preload.ts`), never read from the wire. Defense-in-depth around it: main-computed per-resource CSP **response header**, per-server privileged `lvis-mcp-app://` origin, token↔authority fail-closed binding, `event.source === inner.contentWindow` validation, and a top-frame guard that refuses to run inside the untrusted frame.

## Appendix B — upstream contribution found while building

ext-apps 1.7.4's `.d.ts` files use **extensionless relative imports** (`from "./events"`), which do not resolve under `moduleResolution: NodeNext` (TS2460). The base class `ProtocolWithEvents` — and every member it brings, including `addEventListener` — is therefore invisible to TypeScript. Consequences we carry until it lands: singular setters instead of `addEventListener`, local type twins for `McpUiHostContext` / `McpUiDisplayMode` / `McpUiResourceCsp`, and one deferred anti-drift `it.todo`. Fix submitted upstream: **modelcontextprotocol/ext-apps#705**. When it merges, drop the twins and the `it.todo`.
