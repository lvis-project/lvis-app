# Multi-surface conversation runtime

Status: Implemented foundation — canonical protocol, local adapters, headless one-shot CLI, default-OFF Tailnet observer/controller, P2 owner pairing/share / same-origin Web, P3 paired turn control/bounded image staging, restricted external-platform inbound core, and an opt-in Telegram v1 private-DM adapter
Last updated: 2026-09-06

This document defines how one active main conversation is shared across many
display and command surfaces without creating a second model turn or bypassing
the host permission model.

## Implemented platform core

The canonical event source is now the typed PlatformConversationTimeline, not
the Electron IPC frame shape. Its closed event union separates portable fields
from owner-only detail. Existing Electron IPC and loopback /v1/events remain
compatibility projections; neither is an authoritative second stream.

~~~text
Desktop IPC ─┐                         ┌─ Electron legacy projection
Loopback API ├─ ConversationCommandPort ┼─ PlatformConversationTimeline
future CLI   ┘          |               └─ Local API legacy SSE projection
                         v
                  ConversationLoop
                         |
                         └─ SharedConversationProjectionStore
                              └─ Tailnet observer / future Web, CLI, SNS adapters
~~~

message.send is the first common command. The host, not an HTTP body, mints
its actor/provenance: Loopback input is always surface-user; it cannot claim
user-keyboard, user activation, a persona prompt, or a privileged tool trust
origin. All surfaces still share one turn/mutation lease and the existing local
ApprovalGate.

The runtime owns the bounded shared projection for the entire app lifetime.
That projection is an explicit whitelist: assistant text and generic turn/tool
state are shareable; reasoning, tool arguments/results, execution plans, UI
resources, paths, attachments, memory source text, internal ids, and errors
are never retained there. Its public cursor is dense and projection-local, so
private source events do not leave observable cursor gaps.

## Implemented Tailnet observer/controller and P2 owner sharing

TailnetSurfaceServer is a separate, literal-127.0.0.1 listener. It has no
bearer secret, no /v1 dispatcher, no A2A routes, and no owner-stream adapter.
It is default OFF and starts only when the main-process launch environment contains:

~~~text
LVIS_TAILNET_OBSERVER=1
LVIS_TAILNET_OBSERVER_AUTHORIZATION=tailnet-identity
# ...or the advanced boundary:
# LVIS_TAILNET_OBSERVER_AUTHORIZATION=app-capability:<owned-domain>/cap/lvis-conversation
LVIS_TAILNET_OBSERVER_PORT=46173   # optional; fixed nonzero port
LVIS_TAILNET_CONTROLLER=1          # optional; default OFF
LVIS_TAILNET_PAIRED_SHARING=1      # required for owner pairing/share and Web
LVIS_TAILNET_WEB=1                 # optional same-origin browser adapter
LVIS_TAILNET_WEB_ORIGIN=https://<machine>.<tailnet>.ts.net
~~~

The renderer cannot set these values. The authorization boundary is an explicit
choice with no implicit default: `tailnet-identity` accepts any human identity
Serve vouches for and leaves observe-versus-control to the LVIS share
permission, while `app-capability` additionally requires a capability key
matching an owned Tailscale grant and Serve's accepted app-capability key. The
app never changes Tailscale ACLs or configures Serve automatically. The
app-capability boundary requires Tailscale **1.92 or later**, which supports
Serve's forwarded app-capability
headers. P1 roles and capability keys are intentionally ASCII-only; an
unknown/encoded value fails closed rather than being interpreted permissively.

The observer always exposes only:

~~~text
GET /tailnet/v1/status
GET /tailnet/v1/conversation/snapshot
GET /tailnet/v1/conversation/events?scope=<public-uuid>
~~~

Every request requires both Tailscale-User-Login and the exact
Tailscale-App-Capabilities entry containing { "role": "observer" }.
Tagged-device traffic without a human login is rejected. Snapshots and SSE
envelopes deliberately omit persisted conversation, turn, and event ids.
SSE supports Last-Event-ID, requires the public scope when resuming, returns
409 snapshot-required on a gap/scope mismatch, emits resync-required when
the local main conversation changes, and ends after five minutes with
reauthorize-required so a reconnect re-evaluates policy headers.

When `LVIS_TAILNET_CONTROLLER=1`, exactly one additional native-client route
is registered:

~~~text
POST /tailnet/v1/commands
{ "id": "client-command-id", "type": "conversation.send", "input": "...", "scope": "<public-uuid>" }
~~~

`id` is a client-generated, 8–128-character ASCII identifier
(`[A-Za-z0-9][A-Za-z0-9._:-]*`). Generate a fresh UUID-like id for each new
logical command and reuse that exact id only when retrying the exact same
command; reusing it with a different input or scope returns `409`.

It requires the same human header plus `{ "role": "controller" }` under the
same configured capability. A controller policy should explicitly grant both
observer and controller roles when that actor needs status/SSE as well. The
server derives a stable opaque actor digest from the Serve login header; it
never accepts an actor, origin, session id, attachment provenance or raw bytes,
persona, user gesture, or approval decision from the body. A command is
accepted as `202` only after reserving the one shared turn lease. A durable,
bounded receipt store
keeps only SHA-256 digests of the actor/id, intent, and private conversation
identity (never the login, command text, or conversation content). A terminal
receipt is retained for 24 hours after settlement by default (4,096 receipts).
An unresolved reservation is never automatically expired: a crash-left,
long-running, or local-approval-waiting command returns `409` outcome-unknown
rather than risk starting a second model turn. An unreadable or
capacity-exhausted store returns `503`. Its result appears through the safe
timeline.

The controller is a request surface, not a reusable tool capability. **Every
ToolExecutor invocation, including a declared read, requires an exact local
`allow-once` decision.** The remote client cannot approve it, grant a session
or durable permission, reuse local approval memory, or inherit global
`allow`/reviewer auto-approval. P1 rejects meta operations and explicitly
blocks shell/background access (`bash`, `powershell`, and shell-session reads),
routine scheduling, and tool/instruction expansion (`request_plugin`,
`tool_search`, `skill_load`). This keeps a remote turn bounded to the current
local user-approved action rather than allowing it to create later work or
expand its own capability surface.

The host mints the distinct `tailnet-surface` origin and carries its immutable
controller authority separately; a staged-looking envelope in controller input
remains plain text, never a provenance upgrade. Before a local tool decision,
the controller turn dispatches no external extension hooks at all: lifecycle,
prompt, permission, pre-tool, post-tool, and in-process hook callbacks are
all suppressed by a turn-scoped host policy. Ordinary host-owned conversation
persistence, audit, and cleanup still run; only owner-configured extension
code is excluded. P1-excluded tools and all meta operations are denied before
a path-policy prompt can create a directory grant.

Native `/tailnet/v1/*` and the pairing claim remain CLI/adapter contracts. They
reject an `Origin` header or browser Fetch Metadata context (`Sec-Fetch-Site`,
`Sec-Fetch-Dest`, or `Sec-Fetch-User`) before authorization or rate limiting, so
a browser cannot bypass the separate Web session boundary or exhaust its budget.
The bounded P1 JSON schema remains deliberately narrow. It never accepts
body-embedded attachment bytes, conversation/session mutation, settings,
plugins, memory, policy, or approval commands. P3 adds narrowly scoped paired
control rather than widening the P1 controller into a general remote API.

### P2 local owner pairing and scoped sharing

When `LVIS_TAILNET_PAIRED_SHARING=1`, the Desktop Settings **Tailnet access**
page is the local-owner control plane. The owner can issue a one-time invitation,
activate a claimed pairing, create an observe/control share for only the current
main conversation, and revoke either share or pairing. A claimed invitation is
pending only: it grants no observer or controller access until the owner
activates it and creates a scoped share.

The durable pairing store retains only a code digest, opaque HMAC actor id,
private conversation digest, opaque IDs, expiration, and revoke epochs. It never
retains a raw Tailnet login, invitation code, or persisted conversation ID. The
HMAC secret itself uses main-process OS encrypted storage. The native pairing
redemption route is deliberately separate:

~~~text
POST /tailnet/v2/pairing/claim
{ "code": "lvis-pair-v1.<one-time-code>" }
~~~

It needs the distinct `{ "role": "pairing" }` capability under the
app-capability boundary and rejects browser Origin or Fetch Metadata context
before a capability bucket is consumed; claiming it does not expose a
conversation. A browser redeems through the Web boundary instead, below.

### Same-origin Tailnet Web

Set `LVIS_TAILNET_WEB=1` only together with paired sharing and one canonical
HTTPS `*.ts.net` origin (no credentials, port, path, query, or fragment).
The listener never derives that origin from `Host` or forwarding headers. It
serves no CORS response and provides only:

~~~text
GET  /
GET  /tailnet/v2/web
GET  /tailnet/v2/web/snapshot
GET  /tailnet/v2/web/events?scope=<public-uuid>
POST /tailnet/v2/web/commands
POST /tailnet/v2/web/logout
POST /tailnet/v2/web/pairing/claim
POST /tailnet/v3/web/attachments
~~~

The tailnet root is the same document: the `*.ts.net` name is the whole address
a person is handed, so it must not answer with a 404 they cannot interpret.

The document requires an authorized observer identity plus an active P2 observe
share. Without that share it serves the invitation-code page rather than raw
JSON, backed by a share-less cookie and CSRF pair that can only be presented to
`POST /tailnet/v2/web/pairing/claim` — a second path to pairing behind the full
same-origin Web boundary, not a relaxation of the native route's browser
refusal. It accepts only a top-level browser document navigation with Fetch
Metadata (`Sec-Fetch-Site` `none` or `same-origin`, `Sec-Fetch-Mode: navigate`,
and `Sec-Fetch-Dest: document`), so cross-site and iframe loads cannot consume
session slots. It issues a bounded, in-memory `__Host-` cookie
(`Secure; HttpOnly; SameSite=Strict`) plus one page-local CSRF token. Raw cookie
and CSRF values are never persisted; only domain-separated digests and the
opaque P2 binding are kept in memory. One browser cookie can back several tabs:
each document receives a separate valid page CSRF so opening or refreshing a tab
does not invalidate the others. The document is `no-store`, nonce-CSP,
anti-frame, same-origin-only HTML; it renders shared text with `textContent`.

Every Web API request requires exact same-origin Fetch Metadata plus Origin (or
same-origin Referer), the CSRF token, a fresh Tailscale role, the current main
conversation, and a fresh P2 authorization whose opaque actor and exact
pairing/share binding match the session. `commands` additionally requires both
a controller role and a P2 control share, then rechecks all of those values
after parsing the body and immediately before the existing idempotent command
broker. Pairing/share changes invoke an exact binding guard on each stream, so
unrelated pairing or invitation mutations do not terminate other browser tabs.
A stale binding emits `reauthorize-required`; its next request is rejected and
revokes that session. Explicit logout or session invalidation immediately sends
`reauthorize-required` to the corresponding Web SSE. Session expiry also bounds
the stream. A healthy Web stream reaching its normal transport lifetime emits
`reconnect-required`, which causes a fresh snapshot and authorization check;
the page serializes event-driven snapshot refreshes to at most one per second.
Browser control therefore reuses the same `tailnet-surface` provenance, receipt
store, turn lease, and local-only tool approval policy as native control.

### P3 paired turn control and bounded image staging

P3 is available only to an active P2 **control** share. It does not add a
second controller identity or allow the client to name a local conversation.
For a paired `conversation.send`, the host may return an opaque public turn
handle. The handle is deterministic for the exact durable command receipt, so
an idempotent retry receives the same value, but it contains no actor,
conversation, pairing, share, or receipt identifier. It is never included in
the observer snapshot, shared event projection, or a legacy IPC/SSE frame.

The existing native and Web command routes accept the narrow paired command:

~~~text
{ "id": "client-command-id", "type": "turn.cancel-own", "turnId": "<opaque-public-turn-handle>", "scope": "<public-uuid>" }
~~~

`turn.cancel-own` is not a global abort. The host binds the handle to the exact
opaque actor plus pairing id/epoch, share id/epoch, scope, and current active
turn registration before it exposes the handle. A handle from another actor,
another share, a revoked/reissued binding, a completed turn, or a prior
process returns the same non-oracle `turn-not-found` outcome. It never reveals
whether that turn existed, and it cannot cancel another surface turn. The
active registration is intentionally process-local: durable receipts make send
retries safe, but do not resurrect a cancellable model turn after restart.

P3 image input uses a separate raw-binary staging route, never JSON or a data
URL in `conversation.send`:

~~~text
POST /tailnet/v3/attachments
POST /tailnet/v3/web/attachments
~~~

The native route retains the native-client anti-browser checks and requires the
same paired control authorization. The Web counterpart additionally retains its
same-origin session, Fetch Metadata, Origin, and CSRF checks. Both require the
current public scope in a request header, accept only host-approved image MIME
types and validated image bytes, and return an opaque attachment id. The later
`conversation.send` supplies only those ids. Generic file upload, arbitrary
MIME types, remote filesystem paths, and URL fetches are not part of this
contract.

Staged image bytes live only in a bounded in-memory store, keyed to the exact
paired binding, with a short expiry, per-binding quota, process-wide quota, and
one-time reservation/consume semantics. A failed submission releases its
reservation; a revoked or stale binding makes staging unusable. Raw image bytes
and their data URLs are never written to the command receipt, safe projection,
timeline, or bridge delivery record. Once an accepted turn consumes an image,
the ordinary local conversation history may retain it under the same local
history policy as a desktop image input; staging itself is not a persistence
mechanism.

The P2 store can retain more than one durable pairing/share grant, but the host
still owns one `ConversationLoop` and one global active-turn lease. Multiple
grants therefore do **not** create parallel remote sessions, independent model
loops, or a remote session-selection API. A competing accepted command receives
the established `streaming-active` result. This is an explicit current-runtime
limit rather than a claim that durable shares are independent actors.

Native observer/controller/pairing, Web document loads, and Web commands share
a bounded in-memory mutation budget (120 requests per 60 seconds by default),
keyed only by an opaque login digest and capped to 128 tracked identities. Web
snapshot and event reads use a separate 1,280-per-minute budget: it covers the
16 bounded SSE surfaces refreshing snapshots once per second plus setup and
reconnect margin, while retaining a hard per-login ceiling. Neither bucket logs
or retains the Tailscale login itself.

A Tailnet deployment owner may configure a matching, non-Funnel Serve target,
for example:

~~~text
tailscale serve --accept-app-caps=<owned-domain>/cap/lvis-conversation http://127.0.0.1:46173
~~~

This command is intentionally not executed by LVIS. Do not leave a persistent
Serve target pointing at the fixed port after the app exits: another local
process could later bind that port and receive forwarded identity/capability
headers. Couple Serve enable/disable to an external supervisor or use a
dedicated OS service account. The listener also bounds sockets and requests,
rejects GET bodies, drops slow SSE clients, and forces bounded renewal: native
clients reauthorize while the Web adapter receives an explicit reconnect event.

Tailscale Serve protects Tailnet/LAN ingress only. Any local process able to
reach loopback can forge these headers, so host/OS isolation remains a
deployment prerequisite.

## Telegram private-DM adapter

Telegram is independently default OFF. The owner connects it from the desktop
(`Settings → Connections → Remote surfaces`): the bot token is stored in the
encrypted secret store, updates arrive over an outbound long poll
(`getUpdates`) owned by this process, and pairing is a one-time code the owner
DMs to their own bot. The adapter opens no listener and no public endpoint,
never registers a Telegram webhook, and has no Marketplace/Oracle deployment
dependency. (The earlier environment-configured webhook deployment mode — env
credentials, loopback listener, owner-operated HTTPS terminator — was removed;
polling is the only ingress.)

The provider edge accepts only a private text `message` from a non-bot sender
whose chat and sender identifiers match exactly. It rejects groups, media,
callbacks, replies/forwards, web-app payloads, edits, slash commands, and
every remote session/approval/cancel claim. Authenticity comes from TLS to the
Bot API plus the bot token on the host's own outbound poll — the bytes are
host-fetched, never attacker-presented — and an isolated seven-day durable
receipt store keyed by opaque host digests supplies the replay fence.

Pairing's source of truth is the redeemed pairing code: it binds one Telegram
account digest, and the owner's share binds that digest to one conversation.
A revoke, re-share, pause, disconnect, or re-pair replaces the binding; a
message that arrives while the shared conversation is not on screen is refused
with a control notice, never run in the background. A bot cannot initiate a
chat, so the paired owner must send a normal text message before the host
attaches that route to the bounded safe projection. Outbound delivery uses
plain Bot API `sendMessage` only and consumes no raw timeline content. It
compacts only safe queued projection messages, paces each DM to one launch per
second, and also paces the bot globally to one launch per 34 ms (about 29 per
second, below Telegram's approximate free 30-per-second guidance). Revocation
fences queued and not-yet-launched deliveries, but cannot recall a request
already handed to the Telegram Bot API. The bridge guard fences entry to
`ConversationLoop.runTurn`, but cannot cancel or recall a provider/model turn
already executing inside it. The host retains `platform-bridge` provenance and
local one-shot approval for every tool invocation.

See [Telegram bridge](../guides/telegram-bridge.md) for the owner connection
and pairing steps.

## Deliberately deferred

P3 does not enable arbitrary remote files, cross-restart turn cancellation,
remote conversation/session selection, or independent concurrent
`ConversationLoop` instances. Telegram group/media/callback support, dynamic
owner pairing controls, route sharing across session changes, a durable outbound
outbox, and every other provider (including Discord) remain deferred. A concrete
provider adapter must supply the provider's applicable raw-body
signature/secret/replay verification and explicit account/channel pairing before
it can invoke the core; it must never reuse `user-keyboard`, `/v1`, A2A, or a
human Tailnet controller authority.
## Local compatibility adapters

The Electron main-process composition creates one `ConversationSurfaceRuntime`
with a typed platform timeline, then injects compatibility adapters into
Electron IPC and the optional loopback Local API.

```text
                          ConversationSurfaceRuntime
                     +--------------------------------+
commands ----------> | one turn / mutation lease       | --> ConversationLoop
                     | process-wide stream correlation |
events <------------ | ordered typed platform timeline |
                     +---------------+----------------+
                                     |
          +--------------------------+--------------------------+
          |                                                     |
 Electron IPC projection                                  loopback SSE projection
 primary chat window (explicit future adapters)           existing /v1/events shape
```

The runtime owns a single active main-conversation lease. Electron send,
loopback API send, parent wake, edit/resend, continue, retry, session changes,
and manual compaction therefore cannot interleave state changes in the mutable
`ConversationLoop`. A competing command fails with the established
`streaming-active` outcome before it changes history or temporary provider
settings.

The primary Electron chat window is projected from the same typed timeline through the
existing safe `WebContents` send path. Additional Electron surfaces must attach
an explicit adapter with their own projection; raw conversation frames are
never broadcast to every app window. Local API SSE is another compatibility
adapter over that timeline. Existing renderer IPC and `/v1/events` clients keep
their legacy `(channel, payload)` shape; canonical envelope metadata is not
injected into legacy payloads.

### Current guarantees and limits

- The typed platform timeline uses private per-session ordered cursors, bounded
  in-memory replay, and isolated synchronous listener delivery.
- Legacy IPC/SSE frames are deliberately **live-only**. They can contain raw
  tool/UI data and are neither durable nor reconnect-safe.
- A legacy payload that cannot be structured-cloned is dropped by its adapter;
  it cannot abort a model turn.
- Side-chat remains a separate namespace and is not mixed into the main-chat
  runtime.
- The current `ConversationLoop` is a singleton, so this slice represents one
  active main conversation, not independent per-session parallel actors. This
  remains true even when several durable P2 shares exist.

Implementation anchors:

- `src/engine/conversation-surface-runtime.ts`
- `src/engine/conversation-event-hub.ts`
- `src/engine/conversation-activity-coordinator.ts`
- `src/ipc/domains/chat.ts`
- `src/main/local-api-server.ts`

## Headless one-shot CLI

The main process accepts two one-shot flags. Each boots the ordinary host
service graph and performs exactly one action. Both quit by default. Neither opens a
workspace, and neither is a second conversation runtime: `--exec` runs the same
`runStreamedTurn` producer the desktop window runs and reads the same closed
event union, with a sink that serialises instead of projecting to a renderer.

```text
lvis --exec="<prompt>"              prompt inline; `--exec` or `--exec=-` reads stdin
     [--exec-cwd=<dir>]             session project root (default: the directory
                                    the process was launched from; a relative
                                    path resolves against it). Must be the
                                    default workspace or a directory listed in
                                    permissions.additionalDirectories of
                                    ~/.lvis/settings.json — the run refuses
                                    (exit 64) rather than re-rooting elsewhere
     [--exec-approve=default|allow] permission mode for the run (default: default)
     [--exec-output=stream-json|json]  (default: stream-json)
     [--exec-max-rounds=<n>]        round budget for the turn
     [--exec-keep-alive]            retain a successful streamed session until
                                    SIGTERM or SIGINT from its caller
lvis --set-secret=<key>             secret VALUE is read from stdin, never argv
```

`stream-json` writes every platform conversation event to **stdout** as one
`JSON.stringify(event)` per line; `json` writes no per-event
line and one final line carrying the turn result. Because a reader parses every
stdout line, the process logger moves its console destination to stderr for the
whole run — decided from argv inside `src/lib/logger.ts`, which is the only
place that can decide it, since the logger is built when it is first imported.

`--exec-keep-alive` requires a streamed turn. After the turn returns a successful
exit status, the CLI adds `{"kind":"exec.completed","exitCode":0}` to stdout
and retains the host and its session-owned background services. This record is
a CLI lifecycle message, not part of the conversation event union or proof of
process exit. No further model turn runs. The caller owns cancellation and
eventual termination; SIGTERM or SIGINT releases the request through normal
shutdown and descendant cleanup. Unsuccessful turns exit without retention.

Exit codes are `0` completed, `1` the turn failed or the secret could not be
stored, `2` the turn ended asking for input, `64` a malformed command line, `75` another
LVIS process holds the single-instance lock (retry once it has quit; that
case quits before `whenReady`, so it exits hard with its code and runs no
cleanup). The branch ends with `app.quit()`, not `app.exit()`, so the
`before-quit` shutdown cleanup flushes the session transcript and audit rows
the run produced; the code itself is applied by a `will-quit` handler through
`app.exit()`, because Electron's `quit()` exits 0 whatever `process.exitCode`
holds. A cleanup that hits its timeout exits hard with the same chosen code.

An unattended run has nobody to ask, so it registers a pending-approval observer
that answers every parked request with `deny-once` and notes it on stderr. That
is the whole of its approval behaviour: it never widens a verdict, and
`--exec-approve=allow` sets the permission manager's allow mode without removing
any Layer 0 check. Allow mode does not cover the Layer-1 allowed-directory
prompt either — that prompt is its own request, so an unattended run turns it
into a `deny-once` and every path outside the already-granted set is refused,
which is why a harness has to pre-grant the directories its tasks work in
through the workspace grant document rather than expecting allow mode to reach
them. `--set-secret` writes through the app's own secret store so a
container never has to produce the platform's ciphertext itself; the store's key
validation and its refusal to store a secret it cannot encrypt are surfaced as
exit codes rather than worked around.

`--set-secret` and `--exec` may be combined in one launch, in which case the
secret is applied first and the prompt must be inline — both flags read the
whole of stdin, so only one of them can have it.

A headless boot opens **no discretionary service connection**. `bootstrap()`
takes the launch mode as an argument and derives every one of these from that
single fact: the marketplace catalog is not synced at boot, the admission
registry is not warmed, the release check is not started, neither the
plugin-update nor the announcement poll is scheduled, and neither telemetry
uploader is constructed. What is left is the turn's own egress — the model
provider it talks to and whatever the tools it calls reach.

Two things a headless run must **not** skip. The signed whitelist and
revocation documents are the plugin trust chain, and skipping either would
remove a control rather than save a request: the whitelist fails closed and
gates plugin secret reads, so a headless-only host would lock itself out of its
own secrets once the cached document aged out; the revocation list fails open,
so the same host would silently lose the plugin kill switch. Both are refreshed
on every launch. Admission is the one signed document that is safe to skip — it
is consulted at install, and the install path re-checks freshness itself, so
warming it at boot only ever saved the first install of a session a cold fetch.

Crash reporting splits along the same line: local minidumps are still collected
into the LVIS-owned dump directory, and only their upload is discretionary.
Plugin loading is untouched — the run still loads whatever the registry
snapshot on disk holds, and what is dropped is the network refresh in front of
it. An interactive launch keeps every one of them.

One thing a headless **turn** does differently, rather than skipping. The
`appearance.language` setting names the language the app's surfaces are drawn
in, and a one-shot turn draws none — but the system prompt is assembled through
the same message catalog, so under a non-English setting the model was handed a
prompt written in the machine's language and answered in it whatever language
the request on stdin was written in. A headless turn therefore pins the default
locale at boot, and its prompt carries an explicit rule to answer in the
language of the request in place of the `Locale:` line an interactive prompt
carries. An interactive launch is unchanged: there the setting really is a
statement about the person reading the answer.

This is the one place the two headless flags part company. `--set-secret` is
headless by the same test the log destination uses, but it runs no model and
builds no prompt, so it keeps the persisted language for its own diagnostics —
`execTurnRequested` asks the narrower question, `execModeRequested` the broader
one.

Implementation anchors:

- `src/main/exec-mode.ts`
- `src/main.ts`
- `src/boot.ts` (`BootLaunch`)
- `src/boot/services.ts` (`applyBootLocale`)
- `src/ipc/handlers/chat-stream.ts`

## Telemetry

A run can be made observable as OpenTelemetry spans so an outcome is
attributable to the branch the loop took to reach it. It is off unless
`LVIS_TELEMETRY` names a sink, and off costs nothing: no provider is
registered and the OTel SDK is never evaluated, because
`src/engine/telemetry/tracing.ts` reaches it through dynamic import.

```text
LVIS_TELEMETRY=off              (also: unset, empty)   no provider, no-op tracer
LVIS_TELEMETRY=otlp:<url>       http(s) OTLP/HTTP trace collector
LVIS_TELEMETRY=file:<path>      one JSON object per finished span, appended
```

A malformed spec is logged and leaves tracing off; it never stops the app.
Spans are batched, and the flush runs on `before-quit`, which the `--exec`
branch reaches because it ends with `app.quit()`.

Three layers produce the trace:

| Span or event | Produced by | Carries |
| --- | --- | --- |
| `invoke_agent` / `step` / `chat` | `@ai-sdk/otel`, registered globally | GenAI semantic conventions, model, usage |
| `lvis.turn` | `runTurn` | `lvis.session_id`, `lvis.turn_id`, `lvis.input_origin`, `lvis.turn.stop_reason`, `lvis.turn.tool_count`, `lvis.turn.duration_ms`, `gen_ai.usage.*`, `lvis.usage.fresh_input_tokens`, `lvis.decision.<kind>` counts |
| `execute_tool <name>` | `runTurn`, child of the turn span | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `lvis.tool.group_id`, `lvis.tool.source`, `lvis.tool.category`, `lvis.tool.plugin_id`, `lvis.tool.is_error`, `lvis.tool.result_chars`, `lvis.tool.duration_ms` |
| `lvis.decision` event | `queryLoop`, on the turn span | `lvis.decision.kind`, `lvis.decision.branch`, `lvis.decision.reason`, `lvis.decision.data.*` |
| `lvis.compact.preflight` / `lvis.compact.applied` events | `runTurn` | trigger source and token estimates |
| `lvis.guidance.staged` / `lvis.provider.fallback` events | `runTurn` | disposition and character count / provider names |

The AI SDK spans nest under `lvis.turn` because registering the Node provider
also installs the AsyncLocalStorage context manager.

The decision kinds are `tool_batch`, `tool_schema.drop`, `length.continuation`,
`reasoning_only.continuation`, `tool_search`, `plugin.expansion`,
`compact.micro` and `early_exit`. Each names
a branch the loop chose on its own — a budget it hit, a recovery it took, an
exit it made — and never a provider call.

**Privacy rule.** No prompt text, tool input, or tool output ever enters a
span. The session transcript already holds those and stays on the user's
machine; a span is written to a file or posted to a collector that may not be
theirs. `streamText` is called with `telemetry.recordInputs: false` and
`telemetry.recordOutputs: false` for the same reason. What spans carry is
shapes, counts and host-controlled identifiers.

The same decisions leave the host by two more routes that do not need a
tracing backend: `loop.decision` is a platform conversation event, so
`--exec --exec-output=stream-json` writes one line per decision, and
`TurnSummary.decisionCounts` carries the per-kind totals into the persisted
transcript and the `usage.reported` event.

Implementation anchors:

- `src/engine/telemetry/tracing.ts`
- `src/engine/turn/run-turn.ts`
- `src/engine/turn/query-loop.ts`
- `src/boot.ts`, `src/boot/steps/conversation-wiring.ts`, `src/boot/steps/post-boot.ts`

## Adapter rule

A surface is an adapter, never a second conversation runtime. Electron, local
web, CLI, remote web, Discord, and Telegram must all translate their native
input/output at the edge and use the same host-owned command, approval, audit,
and workspace checks.

The platform timeline is intentionally transport-neutral. It does not authenticate
callers, decide authorization, or redact output. Remote adapters must supply a
host-derived actor context and a safe projection; they must not claim a
privileged local actor by choosing an IPC field or payload value.

Future reconnect support is `safe snapshot + events after cursor`. If the
runtime reports a replay gap or the host restarted, the adapter sends a fresh
safe snapshot instead of treating raw event replay as complete.

## Tailnet-only remote sharing model and controller follow-up

Tailscale can provide the remote-surface network and device/user identity
boundary when the app has no separate account login. It is not a substitute for
application capabilities or tool approval.

The existing loopback `/v1` API and A2A listeners must remain loopback-only and
must **not** be exposed through Tailscale Serve or Funnel. The implemented native
controller uses this distinct service:

```text
Tailnet browser or CLI
        |
Tailscale grants / explicit group policy
        |
Tailscale Serve or Service
        |
127.0.0.1-only TailnetSurfaceServer
        |
identity verification -> actor/capability mapping -> safe event projector
        |
ConversationSurfaceRuntime
```

The backend listens only on loopback. Tailscale Serve is the only supported
network ingress that supplies identity/app-capability headers; use
deny-by-default grants and explicit groups, not `autogroup:member` or broad
wildcard access. This protects the LAN/Tailnet boundary, not against an
untrusted local process able to reach loopback: such a process
can reach loopback and forge HTTP headers. That threat requires ordinary host
and OS-account isolation as well.

| Group | Capabilities |
| --- | --- |
| `group:lvis-observers` | read a redacted snapshot and redacted event projection |
| `group:lvis-controllers` | observer access plus narrow native `conversation.send` |
| no Tailnet group alone | pairing, policy administration, secret read, plugin publish, unattended tool approval |

Remote `conversation.send` never implies permission to run a tool. It retains
an exact local-only `allow-once` ApprovalGate decision for every tool call,
the audit trail, workspace restriction, and a distinct origin such as
`tailnet-surface`; it must never masquerade as `user-keyboard` or `local-api`.

The remote projector defaults to excluding raw tool arguments/results, local
paths, attachment bytes, memory source text, reasoning/private metadata,
capability tokens, IPC names, and internal error stacks. The implemented
Tailnet Web adapter has strict Origin/no-CORS, CSRF, and P2 session boundaries;
any later browser adapter must reuse the same command idempotency, rate-limit,
and slow-subscriber constraints rather than weakening that boundary.

P3 provides a provider-neutral **outbound** bridge boundary: a future adapter
may consume only the bounded safe projection and deliver a normalized safe
message through a bounded channel-specific transport. It is not a raw timeline
fan-out. Discord and Telegram are not Tailnet clients; no provider credential,
webhook listener, or automatic delivery is enabled merely by enabling Tailnet
sharing.

P3 also provides a default-OFF, provider-neutral **restricted inbound core**.
The host calls it only after a provider-specific verifier has authenticated the
raw request and checked its timestamp/replay contract. The core then accepts an
exact, bounded text-only envelope; resolves only a host-owned actor digest plus
an explicitly paired bridge/route binding; reserves a durable de-duplication
receipt; enforces a bounded per-actor rate budget; rechecks the host revocation
guard; and submits only `message.send` through the common command port. It does
not accept attachments, slash commands, session selection, cancellation,
approval resolution, provider identity strings, or a client-selected origin.
The command port forces `platform-bridge` provenance and carries the binding to
each effect boundary. Every tool call is a local, one-shot ApprovalGate decision
even when the local permission mode would otherwise allow it. A stale/revoked
binding therefore fails before admission and immediately before any tool effect.

The core has no network listener and cannot be reached until a separately
configured provider adapter supplies verification and pairing. This separation
keeps provider credentials and channel identifiers outside the common runtime,

## Further controller expansion prerequisites

P3 adds paired `turn.cancel-own`, bounded image staging, and a text-only
restricted inbound core. Do not add arbitrary provider listeners, upload,
remote session mutation, parallel session actors, broader controller authority,
or richer provider-originated input until all of the following
exist:

1. Explicit per-surface ownership, quota, share-specific revocation, and
   cross-process recovery semantics for the new operation.
2. Direct-header spoofing and authorization coverage for every added role,
   transport, and provider callback.
3. A provider-specific verifier and explicit account/channel pairing feeding
   the restricted `platform-bridge` authority; it must never inherit a human
   Tailnet controller role.

Official deployment references: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve),
[access control](https://tailscale.com/docs/features/access-control), and
[grants syntax](https://tailscale.com/docs/reference/syntax/grants).

## Verification

- `src/engine/__tests__/conversation-event-hub.test.ts`
- `src/engine/__tests__/conversation-activity-coordinator.test.ts`
- `src/api/__tests__/local-api.test.ts`
- `src/ipc/domains/__tests__/chat-verbatim.test.ts`
- `src/engine/__tests__/conversation-platform-protocol.test.ts`
- `src/engine/__tests__/shared-conversation-projection.test.ts`
- `src/api/__tests__/platform-conversation-legacy-adapter.test.ts`
- `src/main/__tests__/conversation-command-port.test.ts`
- `src/engine/__tests__/conversation-turn-registry.test.ts`
- `src/api/__tests__/tailnet-surface-server.test.ts`
- `src/api/__tests__/tailnet-attachment-staging-store.test.ts`
- `src/api/__tests__/tailnet-web-session-store.test.ts`
- `src/main/__tests__/tailnet-sharing-owner-service.test.ts`
- `src/ipc/domains/__tests__/tailnet-sharing.test.ts`
- `src/ui/renderer/tabs/__tests__/TailnetAccessContent.test.tsx`
- `src/main/__tests__/tailnet-surface-server.test.ts`
- `src/api/__tests__/tailnet-controller-receipt-store.test.ts`
- `src/permissions/__tests__/permission-manager.test.ts`
- `src/tools/__tests__/executor.test.ts`
