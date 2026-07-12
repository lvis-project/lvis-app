# Per-resource card capabilities — what reviving `permissions` opens up

- Status: **design note, not yet implemented.** Written while wiring the spec's `_meta.ui.permissions` (PR #1600), because that work exposes a declaration channel we have nothing plugged into yet.
- Related: `docs/blueprints/mcp-apps-post-1593-followups.md` (why the host looks the way it does), `docs/guides/mcp-app-authoring.md` (the author-facing contract).

## The gap

`createMcpAppBridge` computes the card's `McpUiHostCapabilities` by reducing over the **static** handlers table:

```ts
const capabilities = handlers.reduce((acc, h) => (h.capability ? { ...acc, ...h.capability } : acc), {});
new AppBridge(null, MCP_APP_HOST_INFO, capabilities, { hostContext });
```

The table is the same for every card. So **every** card — including one that only draws a chart — is handed:

| capability | what the card can do with it |
|---|---|
| `serverTools` | call its server's tools |
| `message` | inject text into the conversation / raise a notification |
| `updateModelContext` | steer what the model sees next turn |
| `downloadFile` | write a file to the user's disk (behind a save dialog) |
| `openLinks` | open an external URL |

Each of those has a **per-invocation** gate (risk classifier, user-gated staging card, save dialog, egress validation), and those gates are good. What is missing is the **per-card** question that comes *before* them: *should this card have been able to ask at all?*

Least privilege is not a gate you add; it is a power you never hand over.

## The opening

`AppBridge` already takes capabilities **per bridge** — i.e. per card. The host can already narrow. What it lacks is anything to narrow *by*: no resource tells us what it needs.

And we are, right now, building exactly the channel that would: a `ui://` resource's **declared policy**, which already carries `csp` and (pending the empirical result) `permissions`, on both arms:

- **plugin arm** — `plugin.json` → `uiResources[]` entry (schema-validated, reviewable before any plugin code runs, covered by `manifestSha256`)
- **external arm** — the resource's `_meta.ui` on `resources/read` (the same place `csp` rides today)

Same channel, same "declared policy, served content" rule, same trust story. Adding a capability declaration to it is not a new mechanism — it is the mechanism we already have, used for the thing it is obviously for.

## The design

One field on the `ui://` resource declaration listing the host capabilities the card needs. The host then **filters the handlers table by it**:

```ts
const active = handlers.filter((h) => !h.key || declared.has(h.key));   // key ⇒ the capability it advertises
const capabilities = active.reduce(...);                                 // advertise only what survived
for (const h of active) h.register(bridge);                              // register only what survived
```

That is the whole change, and it is load-bearing precisely because of the seam that already exists: **capability advertisement and handler registration derive from the same array.** Filter the array once and an undeclared capability is *neither advertised nor registered*. The app does not see it in `initialize`, and if it calls the method anyway it gets a protocol-level "method not supported".

Note what this is **not**: it is not a new gate, not a new check inside a handler, not a policy object consulted at call time. There is nothing extra to debug — an undeclared capability's code path does not exist for that card. That is the owner's rule (*"게이팅 남용은 지양"*) satisfied by construction rather than by discipline.

The per-invocation gates stay exactly as they are. Declaration decides *whether the door exists*; the gates still decide *whether this particular knock gets through it*.

### Details worth deciding before building

- **Default when a resource declares nothing.** Today's behavior is "everything". The honest default is **nothing** (a card that declares no capability is display-only), which is a breaking change for exactly zero cards — none ship yet. Take the strict default now; it will never be this cheap again.
- **Notification vs. conversation.** `message` currently covers both intents (`lvisai/notification` meta routes to the popup; plain text reaches the turn). Those are very different powers — a status card may want to notify and have no business speaking into the conversation. Splitting them is the first thing a per-card declaration makes expressible.
- **`openLinks`** is cheap to grant and rarely dangerous (http(s)-only, opens in the user's browser); it may not be worth declaring. Do not add ceremony where there is no power.
- **External servers** have no manifest, so their declaration rides `_meta.ui`. Until the spec adopts a field, that means a vendor key (`lvisai/*`) — which is the upstream candidate below, and the reason to propose it rather than quietly ship a proprietary one.

## Upstream

This is a **spec gap, not a LVIS gap**: the spec defines per-resource `permissions` for *browser* features (camera / microphone / geolocation / clipboardWrite) but gives a resource no way to declare which *host* capabilities it needs — even though `AppBridge` is constructed with capabilities per card. The consequence is that every conformant host hands every card the full set.

Proposal to upstream (archived in the contribution backlog, to be submitted per the usual fix-first-then-issue order): extend the existing per-resource declaration with a host-capability axis, so a host can advertise `declared ∩ supported`. Our implementation would be the reference: the handlers-table seam makes it a filter, not a framework.

A second, sharper spec question is pending the empirical result of the `permissions` wiring in #1600: the spec mandates the card frame be `sandbox="allow-scripts"` (no `allow-same-origin` ⇒ **opaque origin**) *and* defines camera / microphone / geolocation permissions — which browsers do not grant to opaque origins. If our real-`<webview>` test confirms those three are dead under the mandated sandbox, the spec is defining features its own isolation model forbids, and that is worth raising on its own.
