# MCP Apps — What #1593 Unlocks (Post-Landing Assessment)

- Status: **Draft for owner review** (assessment only; each follow-up below needs separate go)
- Trigger: PR #1593 (`02efcb87`) replaced the dead hand-rolled MCP-Apps bridge with the upstream `@modelcontextprotocol/ext-apps` `AppBridge` over a host-owned sandbox-proxy transport. This doc answers: *now that the bridge landed, what can we improve on the app and plugin side that we could not before?*
- Not in scope: improving #1593 itself. #1593 is merged, CI-green, cluster-passed. The two security items flagged during survey were independently re-verified against the shipping code and are **non-issues** (see Appendix A).

## TL;DR

#1593 built and hardened the **host render path** for MCP App `ui://` resources. The pipeline is live end-to-end **today**: a plugin tool that returns `_meta.ui.resourceUri` gets its `ui://` HTML rendered in a sandboxed webview with a real per-resource CSP. What #1593 deliberately left as `{}` is the **two-way conversation** between host and app:

- **Host → App context is empty.** `mcp-app-bridge.ts:41` constructs the bridge with `{ hostContext: {} }` and never calls `sendHostContextChange`. No theme, no locale, no timezone, no size reaches a running app.
- **App → Host capability is one method wide.** Only `onreadresource` is wired. An app can read its server's resources but cannot call its tools, resize itself, open a link, or post to chat.

Those two gaps are the unlock list. The highest-value one — **push the host's theme + locale down the bridge** — also closes two long-standing `DESIGN.md` open questions (plugin theme signal, plugin locale signal) with an upstream-standard answer instead of a bespoke one.

**One load-bearing fact that reorders everything below: no plugin ships a `ui://` MCP App resource today — the pipeline is built, secure, and currently unused** (verified: grep across all 7 plugin repos + `@lvis/plugin-sdk` src returns zero `ui://` / `_meta.ui.resourceUri` / ext-apps consumers). So #1593 delivered a *capability*, not yet *value*. The host-side gaps (P0/P1) have no consumer to serve until a plugin ships an app. That makes the **first adopter (P2) the real gate to realizing any return on #1593** — and P0/P1 are what make that first app good rather than a bare-themed, display-only card. Sequence accordingly: pick the adopter, then wire host-side context/handlers against a concrete app that exercises them.

## The unlock model (what the bridge made possible)

```
plugin tool result  _meta.ui.resourceUri (nested, stable-spec form)
   → plugin-mcp-host.ts:229  builds McpUiPayload
   → McpAppView               renders <webview> on per-server partition
   → readUiResource IPC       main mints proxy session + per-resource CSP header
   → sandbox-proxy document    host-owned, script-free (mcp-app-protocol.ts)
   → relay preload             mounts inner <iframe sandbox="allow-scripts" srcdoc>
   → AppBridge ⇄ WebviewIpcTransport ⇄ webview ipc ⇄ preload ⇄ inner App
```

Everything above the dashed handshake is built and secure. The **App** object inside the inner frame is the upstream ext-apps `App` — it already *speaks* the full View SDK (`callServerTool`, `sendSizeChanged`, `openLink`, `requestDisplayMode`, `onhostcontextchanged`, …). Each of those calls lands on an `AppBridge` handler **the host has not registered yet**. So the unlock is host-side handler wiring, not new protocol.

## Prioritized follow-ups

### P0 — Populate `HostContext` (theme + locale + timezone) and push on change
**Why first:** it is the single change that (a) makes every plugin app UI theme-match and localize for free, and (b) closes `DESIGN.md:226` (theme signal) and `DESIGN.md:227` (locale signal) — both marked *"design pending"* — with the upstream-standard `McpUiHostContext` shape rather than a LVIS-bespoke one.

- Today: `new AppBridge(null, HOST_INFO, { serverResources: {} }, { hostContext: {} })` — empty (`mcp-app-bridge.ts:41`).
- Change: build the initial `hostContext` from the active theme bundle's `--lvis-*` tokens (→ `styles.variables`), `theme` (light/dark), the host UI `locale` (BCP-47), and `timeZone` (IANA). Subscribe to theme/locale change and call `bridge.sendHostContextChange(...)`; the app receives `onhostcontextchanged` with zero extra plugin wiring.
- `DESIGN.md:226` explicitly asks whether to keep the full `--lvis-*` token dump or *"narrow to a minimal light/dark + semantic-variable signal."* The ext-apps `HostContext.styles.variables` **is** that narrowed, standardized shape — adopting it answers the open question by picking the upstream contract.
- Decision needed: which token subset maps to `styles.variables` (full `--lvis-*` set vs a curated semantic core). Recommend curated core — it is the forward-compatible contract and avoids leaking internal token churn to plugins.

### P1 — Wire the app → host capability handlers
The `App` SDK can already call these; the host just needs to answer.

| Handler | Effect once wired | Notes / dependency |
|---|---|---|
| `onsizechanged` | app auto-resizes its card instead of the fixed `height ?? 300` (`McpAppView.tsx:57`) | pure win, no new trust surface |
| `oncalltool` | app can invoke **its own server's** tools (buttons, forms) — turns a static card into an interactive app | **needs a new `callTool` IPC**: `internal-surface.ts` exposes only `readUiResource`/`onServerDisconnected`/`disposeUiSession`. Route through the same main-process chokepoint + per-invocation host risk classifier that a model tool-call uses (`inspectHostRisk`) — do **not** bypass it |
| `onopenlink` | app opens an external URL through the host | reuse the **just-landed** `openExternalUrl` hostApi shim (PR #1592) — nice synergy |
| `onsendmessage` | app posts a structured message into the chat thread | scope carefully — this writes to the transcript |
| `onrequestdisplaymode` | fullscreen / pip for richer apps | pairs with advertising `availableDisplayModes` in HostContext |

`oncalltool` is the one that changes what "an MCP App" *is* (interactive vs display-only). It is also the one with a real trust boundary — it must go through the existing host-side risk gate, not a side channel.

### P1 (re-ranked up) — First adopter + plugin-author DX (make shipping a `ui://` app real)
Because the pipeline is unused, this is the gate to any value, not a nicety.

- **Locked decision (owner, 2026-07-11): a plugin converts to an MCP App by using the MCP library (`@modelcontextprotocol/ext-apps`) DIRECTLY. No `@lvis/plugin-sdk` UI helper / re-export is added.** This is by design, not a gap — it keeps the SDK a thin types+contract mirror (consistent with the v7 UI removal and v8 runtime-shim removal) and avoids re-growing the surface we just cut. The MCP library *is* the plugin-author contract for app UIs.
- **Verified state:** `@lvis/plugin-sdk/src` has **no** MCP-App helper (grep: no `ext-apps` / `ui://` / `resourceUri` / `registerAppResource`) — which is now the intended end state, not a hole to fill. An author returns `_meta.ui.resourceUri` from a tool and serves the `ui://` resource with `@modelcontextprotocol/ext-apps/server` + the app-side SDK directly.
- **Verified state:** zero plugins ship a `ui://` resource (grep across git / local-indexer / meeting / ms-graph / template / work-assistant / ep). The capability has no consumer.
- DX investment is therefore **example + docs only**: (a) a worked example plugin shipping a real `ui://` card built straight on `@modelcontextprotocol/ext-apps`; (b) an author-guide docs page (incl. the CSP/permissions surface below). An SDK helper is explicitly **out of scope** per the locked decision. The example doubles as the concrete app P0/P1 wire against.
- Candidate first adopter: whichever plugin has a naturally visual result (meeting summary card, indexer status, ep record preview). Pick one; keep the app tiny.

### P2 — Surface per-resource CSP + permissions in author guidance
The host already honors per-resource `McpUiResourceCsp` (connect/resource/frame/baseUri domains) and `McpUiResourcePermissions` (camera/mic/geo/clipboard → inner-iframe Permission-Policy) — `types.ts:278–304`. This is genuinely useful and completely undocumented for plugin authors. Cheap to document alongside the P2 example.

## Strategic thread — two webview surfaces, one context model

There are now **two** plugin-facing webview surfaces:

1. **Plugin panel webviews** (`plugin-ui-host.tsx`, `plugin-ui-shell.html`) — the existing surface that gets *only the shared font stack* (`DESIGN.md:117–120`). The `DESIGN.md:226/227` theme/locale open questions are about **this** surface.
2. **MCP App `ui://` webviews** (`McpAppView` + `AppBridge`) — the new #1593 surface, where `HostContext` is the native, standardized theme/locale channel.

The P0 work gives surface #2 a clean, upstream-blessed theme/locale story. That reframes the surface-#1 open questions from *"design a bespoke signal"* to a strategic choice: **do panel webviews adopt the same `HostContext` model (convergence toward one UI story), or keep their own `host.theme.changed` event?** Recommendation: treat P0 as the reference implementation, then decide convergence — do not design a second, different theme/locale signal for panels in parallel.

## Non-goals / guardrails

- Do not weaken the sandbox to add features. Every P1 handler runs host-side; none require touching the inner frame's `allow-scripts`-only sandbox or the main-computed CSP.
- `oncalltool` must reuse the existing per-invocation risk classifier. An app-initiated tool call is not more trusted than a model-initiated one.
- Do not re-grow the SDK UI surface. Locked (owner, 2026-07-11): plugins use `@modelcontextprotocol/ext-apps` directly; DX is example + docs, never an `@lvis` UI helper.
- App-Provided Tools (draft-spec: apps registering their own tools back to the model) is **upstream-draft, not stable** — track it, do not build against it yet.

## Appendix A — security re-verification (independent, against shipping code)

Two items were flagged during the ext-apps survey; both checked against merged `02efcb87` and found to be non-issues:

1. **"Does the host assume a non-existent SDK `SandboxProxyTransport` class?"** — No. `webview-ipc-transport.ts` implements the generic SDK `Transport` interface (`WebviewIpcTransport`) precisely because `PostMessageTransport` cannot work for a `<webview>` (no usable `contentWindow`). Correct DIY, documented in-file.
2. **"Did the untrusted inner View iframe get `allow-same-origin`?"** — No. `INNER_SANDBOX_ATTR = "allow-scripts"` (`mcp-app-bridge-contract.ts:40`), set **unconditionally host-owned** in `createInnerAppFrame` (`mcp-app-preload.ts`), never read from the wire. Defense-in-depth around it: main-computed per-resource CSP **response header**, per-server privileged `lvis-mcp-app://` origin, token↔authority fail-closed binding, `event.source === inner.contentWindow` validation, and a top-frame guard that refuses to run inside the untrusted frame.
