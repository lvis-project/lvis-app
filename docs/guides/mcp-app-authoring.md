# Authoring an MCP App (`ui://` card) in a LVIS plugin

An **MCP App** is an interactive HTML card the host renders next to a tool result: a meeting summary you can expand, an indexer status you can re-run, a form that calls a tool back. It is not a LVIS invention — it is the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps) (spec `2026-01-26`), and LVIS is one host that implements it.

**A plugin builds its app against `@modelcontextprotocol/ext-apps` directly.** There is no `@lvis/plugin-sdk` UI helper and there will not be one — the MCP library *is* the contract. Anything you learn here transfers to any other MCP Apps host.

Three moving parts:

| Part | Where it lives | What it does |
|---|---|---|
| **Declare** | `plugin.json` → `uiResources[]` | names the `ui://` uri and its security policy |
| **Serve** | `RuntimePlugin.readUiResource(uri)` | returns the card's HTML bytes |
| **Trigger** | a tool handler's `_meta.ui.resourceUri` | asks the host to render that card with this result |

The rule that ties them together is **declared policy, served content**: the manifest declares *what a card may do* (statically reviewable, covered by `manifestSha256`); your plugin serves *what the card is* at read time. The host never reads a path you hand it.

---

## 1. Declare the resource

```jsonc
// plugin.json
{
  "id": "my-plugin",
  "uiResources": [
    {
      "uri": "ui://my-plugin/report",          // authority MUST equal your plugin id
      "csp": {
        "connectDomains": ["https://api.example.com"],  // fetch/XHR/WebSocket → connect-src
        "resourceDomains": ["https://cdn.example.com"], // img/script/style/font/media
        "frameDomains": [],                              // nested iframes → frame-src
        "baseUriDomains": []                             // base-uri
      }
    }
  ]
}
```

- **`uri`** — `ui://<your-plugin-id>/<path>`. The authority must be your own plugin id; the host re-checks this fail-closed at serve time. You cannot serve into another plugin's namespace.
- **`csp`** — domain *buckets*, not CSP directive names. Main **computes** the Content-Security-Policy response header from these; you never supply a header string. Omit a bucket to allow nothing in it. **Least privilege is not advice here — it is the whole point of the field being in the manifest**: a reviewer sees exactly what your card may reach before any of your code runs.
- **No powerful features.** The spec also defines a `permissions` block (camera / microphone / geolocation / clipboard-write). LVIS does not model it, and declaring it fails manifest validation. Your card runs in a frame with `sandbox="allow-scripts"` and no `allow-same-origin`, so it lives on an *opaque origin* — a powerful feature cannot be delegated to one. Design cards that do not need them; if you need the camera, do it in a tool, not in the card.

The `csp` stays in the *manifest* on purpose. If it came back from your `readUiResource` hook, a plugin could present a narrow policy at review and widen it at runtime.

## 2. Serve the HTML

```ts
// your RuntimePlugin factory
export default function createPlugin(ctx: PluginRuntimeContext): RuntimePlugin {
  return {
    handlers: { /* … your tools … */ },

    readUiResource(uri) {
      if (uri === "ui://my-plugin/report") {
        return readFileSync(join(ctx.pluginRoot, "dist/report.html"), "utf8");
      }
      throw new Error(`unknown ui resource: ${uri}`);
    },
  };
}
```

You are the MCP server; the host relays. The host only calls this hook for a uri **you declared** and whose authority it **already verified**, so the hook's own job is small: return bytes. It is bounded by the host at a single chokepoint — a 10 s ceiling and a 4 MiB HTML cap, fail-closed — so ship a self-contained document (inline your CSS/JS, or bundle to one file), not a loader that fans out to disk.

## 3. Trigger the card from a tool

Put the standard `_meta.ui` on what your tool handler returns. Same keys an external MCP server puts on its `CallToolResult` — nothing LVIS-specific; the loopback delegate lifts them onto the wire for you.

```ts
async function handleGenerateReport(args) {
  const report = await buildReport(args);
  return {
    summary: report.summary,          // ← everything OUTSIDE _meta is what the MODEL reads
    warnings: report.warnings,
    _meta: {
      ui: {
        resourceUri: "ui://my-plugin/report",   // required
        title: "Q3 Report",                     // optional — webview title bar
        height: 420,                            // optional — initial px (the app can resize itself later)
        slot: "chat",                           // optional — defaults to "chat"
      },
    },
  };
}
```

`_meta` is protocol, not payload: the host strips it, and the model reads the rest (stringified if it is not already a string). So the card is *in addition to* the reply, never instead of it — **write a result that stands on its own, because the model cannot see your card.** The strip happens whether or not the card renders, so the model's view never depends on the UI.

Only a **declared** `resourceUri` renders. An undeclared one is dropped, not served.

## 4. Build the app itself

Inside the card, use the ext-apps View SDK directly:

```ts
import { App } from "@modelcontextprotocol/ext-apps/app";

const app = new App({ name: "my-plugin-report", version: "1.0.0" });
await app.connect();

const ctx = app.hostContext;        // theme, locale, timeZone, displayMode, styles…
app.onhostcontextchanged = (next) => applyTheme(next);
```

### What the host gives you (`HostContext`)

| Field | Value |
|---|---|
| `theme` | `"light"` / `"dark"` |
| `locale` | BCP-47, e.g. `"ko"` |
| `timeZone` | IANA, e.g. `"Asia/Seoul"` |
| `displayMode` | the mode this card is **currently** in |
| `availableDisplayModes` | `["inline", "fullscreen"]` — what this host can actually apply |
| `styles.variables` | the host theme, as **standard** `McpUiStyleVariableKey` CSS variables |

`styles.variables` uses the spec's fixed vocabulary — `--color-background-primary`, `--color-text-secondary`, `--color-background-danger`, `--border-radius-md`, `--font-text-md-size`, … — never LVIS's internal `--lvis-*` names. Style against those keys and your card themes correctly on any MCP Apps host, not just this one. The host pushes updates on theme/locale change; re-read from `onhostcontextchanged` rather than caching at boot.

### What you can ask the host to do

| Call | Behavior in LVIS |
|---|---|
| `app.callServerTool(name, args)` | calls **your own plugin's** tool. See the visibility gate below. |
| `app.sendSizeChanged({ height })` | the card resizes to fit — do this instead of guessing `height` |
| `app.openLink({ url })` | opens an external URL through the host |
| `app.requestDisplayMode({ mode })` | `inline` or `fullscreen`. **`pip` is not available** — the response tells you the mode actually applied, which may not be the one you asked for. Always render from the response, never assume. |
| `app.sendMessage({ role, content })` | see *Talking to the conversation* below |
| `app.updateModelContext({ … })` | see *Talking to the model* below |
| `app.downloadFile({ … })` | inline bytes → a save dialog. The host does **not** fetch a URL for you; a `resource_link` is rejected. |

### The visibility gate on `callServerTool` — read this before you debug it

The spec says a host **MUST** reject an app's call to a tool whose `_meta.ui.visibility` does not include `"app"`. LVIS enforces it. A tool that omits `visibility` gets the spec default `["model", "app"]`, so it is app-callable out of the box — narrow it to `["model"]` and your card can no longer call it, by design.

```jsonc
// plugin.json → tools[]
{ "name": "my_plugin_refresh" }                                                   // dual by default — your card CAN call it
{ "name": "my_plugin_refresh", "_meta": { "ui": { "visibility": ["model", "app"] } } }  // the same thing, spelled out
{ "name": "my_plugin_delete",  "_meta": { "ui": { "visibility": ["model"] } } }         // model only — card cannot call
{ "name": "my_plugin_panel_ping", "_meta": { "ui": { "visibility": ["app"] } } }        // ⚠ NOT for cards — see below
```

**Do not declare `["app"]` for a tool your card calls.** In LVIS that marks a tool for the plugin's own trusted React panel — an app-only tool never enters the risk-gated tool registry, so there is no gate to run it under, and a call from a card is refused. It is the one visibility a card cannot use. Give a card-callable tool the default (or dual) visibility. Making the spec's `["app"]` work for cards means governing non-registry tools, which is tracked as a follow-up, not shipped.

**A call from your card is not more trusted than a call from the model.** It goes through the same host risk classifier and the same approval gate — a `write`/`shell`/`network` tool can prompt the user, and the user can deny it. Handle rejection in your UI; do not assume a call succeeds. Your card also cannot name a *different* server: the host binds the target from the trusted payload, and a cross-server call is denied.

### Talking to the conversation (`sendMessage`)

Two intents, and the host decides which by looking at the content block's `_meta`.

**A popup notification** — reaches the user, never the model, never the transcript:

```ts
app.sendMessage({
  role: "user",
  content: [{
    type: "text",
    text: "Build finished",
    _meta: {
      "lvisai/notification": {
        title: "Build finished",
        body: "3 warnings, 0 errors",
        severity: "info",            // "info" | "warning" | "critical"
      },
    },
  }],
});
```

**Text into the conversation** — a plain `text` block with no notification meta:

```ts
app.sendMessage({ role: "user", content: [{ type: "text", text: "Summarize the Q3 report card." }] });
```

What happens next depends on the host's state, and **your card cannot wake the model either way**:

- **A turn is in flight** → your text joins the guidance queue and reaches the model as part of that turn, **with no user confirmation**. Be deliberate about what you send on this path: it is ungated. The rest of that turn is downgraded to your app's provenance, which force-asks the user before any `write` / `shell` / `network` tool the model then reaches for.
- **No turn in flight** → the host raises a **staging card**; the user clicks to send. This is deliberate and matches every other host (VS Code fills the chat input without auto-sending; OpenAI requires a synchronous user gesture). An app that could start a turn on its own could drive the model with no one watching.

Either way the message is tagged `app-emitted` and wrapped so the model sees it came from your app, not from the user's keyboard. Text is capped at 4096 characters. The two intents are exclusive: notification meta wins, and that message never reaches the conversation.

### Talking to the model (`updateModelContext`)

An **overwrite slot**, not a message: the host stores your latest context and folds it into the *next* turn the user starts. Calling it does not wake the model, does not append to the transcript, and a second call replaces the first. Use it to keep the model aware of what the card is currently showing ("user is viewing rows 40–60, filtered to failures") so the next question lands with context.

## 5. Test it

- The host renders your card in a sandboxed webview whose inner frame is `sandbox="allow-scripts"` only — **no same-origin, no storage, no cookies**. `localStorage`/`sessionStorage` throw. Keep state in the app, or push it to your plugin with a tool call.
- Your card's network access is exactly `csp.connectDomains`. If a fetch fails silently, check the manifest before you check your code.
- Nothing in the card can inject a CSP or a sandbox attribute — those are host-computed and host-owned. If you need a domain, declare it.

## Where the pieces are (host source, for when something misbehaves)

| Symptom | Look at |
|---|---|
| card never renders | `plugin-runtime-delegate.ts` (does `_meta.ui` reach the wire?), then `plugin-ui-resource-provider.ts` (declared? authority?) |
| card renders blank / CSP error | the per-resource header main computes from your `csp` |
| `callServerTool` rejected | the visibility gate, then the risk classifier / approval gate |
| a handler does nothing at all | the handlers table in `mcp-app-bridge.ts` — the host's advertised capabilities are derived from the same array that registers the handlers, so what it advertises is what it answers |

## Reference

- Spec: [MCP Apps, `2026-01-26`](https://github.com/modelcontextprotocol/ext-apps)
- SDK: `@modelcontextprotocol/ext-apps` (`/app` for the View side, `/server` for the server side)
- Why the host looks the way it does: `docs/blueprints/mcp-apps-post-1593-followups.md`
