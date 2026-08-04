# Telegram bridge

The Telegram bridge lets one Telegram private DM reach one active LVIS
conversation. It is off until an owner turns it on, and it is intentionally
separate from the loopback `/v1` API, A2A, and Tailnet services.

There are two ways to run it, and they are mutually exclusive. When the launch
environment configures the bridge, that configuration wins and the desktop
screen is read-only.

| | Desktop connection | Environment deployment |
|---|---|---|
| Configured in | `Settings → Connections → Remote surfaces` | Launch environment variables |
| Receives via | Outbound long polling (`getUpdates`) | Inbound webhook on a loopback listener |
| Public endpoint | None | Owner-operated HTTPS terminator |
| Pairing | One-time code sent to the bot | Fixed numeric allow-list |
| Intended for | A personal desktop | An always-on server |

## Desktop connection

The desktop path exists because the webhook deployment's own safety
requirement — that a proxy's forwarding lifecycle be coupled to the bridge
lifecycle — cannot be enforced by an app with a Disconnect button. Polling
opens no listener, so there is no fixed port whose forwarding can outlive the
bridge.

### What connecting means

Connecting is an egress decision, and a broader one than the webhook path's.

- LVIS stores the BotFather token in this machine's encrypted credential
  store. On a machine with no usable encrypted store, connecting is refused
  rather than falling back to plain text.
- While connected, LVIS keeps an outbound request open to `api.telegram.org`.
  That discloses this desktop's network address and its online pattern to
  Telegram **before** any account is paired and before any conversation is
  shared. Pausing stops the poll loop, not merely inbound handling.
- Messages sent to the bot before connecting are discarded rather than
  replayed. Replaying a backlog would run each one as a live turn.

### What LVIS never does to your bot

LVIS calls only `getMe`, `getWebhookInfo`, and `getUpdates`. It never calls
`setWebhook`, `deleteWebhook`, `logOut`, or `close`. If the bot already has a
webhook registered, connecting fails closed and asks you to remove it in your
own deployment; LVIS will not remove it for you, because that would destroy a
deployment it does not own.

### Pairing

A bot cannot open a chat, so the paired owner always sends the first message.

1. Create a bot with `@BotFather` and paste its token into the connect form.
2. Choose **Pair my Telegram account**. LVIS mints a single-use code of the
   form `lvis-tg-v1.<43 characters>`, shown once.
3. Send that code to the bot as an ordinary message.

The code is deliberately not a slash command. The shared ingress core rejects
every leading-slash message unconditionally, and admitting a Telegram account
is a privileged action; a `/start` consumer would have to branch that gate.
Deep links of the form `t.me/<bot>?start=<payload>` are therefore not usable.

Redemption is consumed before the message can reach the conversation, so a
pairing code never enters the transcript. Text that merely looks like a code is
consumed and dropped too, so a near-miss credential cannot land there either.
The code is single-use, expires, and has a small attempt budget; exhausting
that budget destroys it, after which even the correct code no longer pairs.

Unknown senders receive no reply at all. Any Telegram user can message a bot,
and answering would confirm to a stranger that this bot is attached to a live
desktop.

The paired owner is a different case. When their message cannot be routed —
because nothing is shared, or because the shared conversation is not the one
open on the desktop — LVIS answers with a fixed host notice saying so. It
carries no conversation material, goes only to the paired account, and is sent
at most once every ten minutes per chat so a flood of unroutable messages cannot
turn the bridge into a reply amplifier. A notice that fails to send is not
retried; silence is preferable to a loop.

This is deliberately a second, narrow egress path. The conversation delivery
channel is fenced by the route guard, and that fence is precisely what is
closed when there is nothing to say — so without this path an unroutable
message would be consumed and answered with nothing, which is indistinguishable
from a dead bot.

### Pairing is not access

A paired account still sees nothing. Sharing is a separate, explicitly
gestured action that binds the conversation you have open, for a fixed
duration.

That binding is durable and it is the whole point: your phone talks to the
conversation you shared, not to whichever one you happen to have open. It
survives closing the conversation and it survives restarting the app, and only
one conversation is shared at a time — sharing another one replaces it, so
there is never a grant you cannot see. LVIS stores that conversation's local
identifier next to the opaque digest the share was granted under, and refuses
the record unless the two still agree, so hand-editing the file yields no share
rather than a re-pointed one. Revoking the share, re-sharing under a new grant,
pausing, or disconnecting each invalidates the previous binding.

Running a turn is a narrower question than being shared. Because the host runs
one active session, replies run only while the shared conversation is the one on
screen; open a different one and the desktop says so and answers Telegram with
the host notice, without dropping the share. Opening the shared conversation
again continues it. Running a shared conversation in the background is not
something LVIS does today.

### What leaves this desktop

Only assistant text and coarse progress, through the shared safe projection.
Model reasoning, tool inputs and results, local paths, attachments, memory
source text, internal identifiers, and error stacks do not.

Tool approvals stay local. A Telegram message can start work that needs an
approval, but the approval prompt appears only in the desktop app; Telegram
cannot answer it.

### Pausing and disconnecting

Pausing stops queued sends and any send not yet handed to the Bot API. It
cannot recall a request already handed over, even if LVIS has not yet seen the
response.

Disconnecting deletes the stored token, revokes the pairing and any share,
stops receiving, and leaves your bot exactly as it was on Telegram's side.

## Environment deployment

This path is unchanged. Supply these through the app's launch environment or a
service-manager secret facility; never commit them to a repository, shell
profile, Marketplace Compose file, or a `.env` tracked by Git.

```text
LVIS_TELEGRAM_BRIDGE=1
LVIS_TELEGRAM_BOT_TOKEN=<BotFather token>
LVIS_TELEGRAM_WEBHOOK_SECRET=<32-256 ASCII chars matching [A-Za-z0-9_-]>
LVIS_TELEGRAM_ALLOWED_USER_IDS=<your numeric Telegram user id[,another-id], no spaces>
LVIS_TELEGRAM_PORT=46175                         # optional fixed loopback port
LVIS_TELEGRAM_WEBHOOK_PATH=/telegram/webhook      # optional exact path
LVIS_TELEGRAM_ROUTE_EPOCH=1                       # bump to fence prior route bindings
```

In this path the bot token and webhook secret are process environment values
and are never written to LVIS settings. The listener is off unless
`LVIS_TELEGRAM_BRIDGE=1`, and an enabled-but-unused bridge makes no network
contact with Telegram at all. It always binds literal `127.0.0.1`. A malformed
enabled configuration fails closed and leaves this auxiliary adapter
unavailable while the desktop app continues booting.

`LVIS_TELEGRAM_ALLOWED_USER_IDS` is this path's pairing source of truth. It
accepts only canonical positive Telegram numeric IDs, not usernames, and the
allowed owner must send the first message before LVIS attaches that DM to the
safe projection. When more than one owner is configured, they share the one
active conversation's projection; they are not independent sessions. In this
path the route binds the conversation captured at app start — change the
configuration and restart to bind a different one.

Inbound requests must carry Telegram's configured `secret_token` header before
their JSON is parsed. Only private, text-only messages from an exact allowed
Telegram user ID reach the common `platform-bridge` command path, and the host
assigns that provenance itself: the request cannot claim local keyboard trust,
a Tailnet role, a session, an attachment, an approval, or a cancellation.

Raw Telegram IDs, message text, the bot token, the webhook secret, and the
conversation ID are not written to the bridge receipt file. The runtime uses an
OS-encrypted HMAC secret to derive opaque actor and route bindings.

### Public HTTPS termination and webhook registration

Operate a dedicated public HTTPS hostname/path that forwards only to the
loopback listener. Do not expose the app's `/v1`, `/a2a`, Tailnet, or
Marketplace routes through that proxy. The proxy must preserve the raw body and
`X-Telegram-Bot-Api-Secret-Token` header, disable request-body logging and
caching, and enforce the same 64 KiB request cap.

**Fixed-port safety requirement:** do not leave a persistent proxy or tunnel
forwarding to the configured `LVIS_TELEGRAM_PORT` loopback target (default
`127.0.0.1:46175`) unless its forwarding lifecycle is coupled to the bridge
lifecycle. If LVIS stops and the proxy keeps forwarding, another local process
could bind that configured port and receive webhook bodies and the Telegram
secret header. Stop forwarding before or with the bridge, or use a dedicated OS
account/socket ACL that prevents another local process from receiving the
traffic, or an authenticated local relay whose backend binding is itself tied
to the bridge. Without one of these controls, do not operate this fixed-port
deployment.

Telegram's cloud Bot API requires a public HTTPS webhook endpoint on its
supported ports. Configure the endpoint only after the tunnel/proxy works:

```bash
curl --fail-with-body --request POST \
  "https://api.telegram.org/bot${LVIS_TELEGRAM_BOT_TOKEN}/setWebhook" \
  --header 'content-type: application/json' \
  --data @- <<JSON
{
  "url": "https://telegram-bridge.example.com/telegram/webhook",
  "secret_token": "${LVIS_TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ["message"],
  "max_connections": 1
}
JSON
```

On Windows PowerShell, build the same JSON through `ConvertTo-Json` and call
`Invoke-RestMethod`; keep the bot token and secret in process environment
variables rather than embedding either value in a script file.

This command is deliberately not built into LVIS: it mutates a third-party
production bot and makes a public endpoint authoritative. Use `getWebhookInfo`
to verify the URL and inspect delivery errors. Do not add `drop_pending_updates`
unless discarding pending messages is an explicit owner decision.

If Cloudflare fronts the hostname, give the webhook a dedicated route and
disable browser-oriented JavaScript, Turnstile, and bot challenges on that
route—Telegram cannot solve them. Retain tunnel/origin reachability controls
and the Telegram secret-header check; a challenge bypass must not become a
broad proxy bypass.

The Marketplace Oracle Compose deployment is not the Telegram bridge host and
must not receive the bot token or a generic `/telegram` proxy route. A separate
relay design would be required to bridge that deployment to a desktop app.

## Operational limits

These apply to both paths.

- Inbound deliveries use durable, plaintext-free receipts for seven days. The
  outbound projection is live, bounded, and at-most-once: after a process
  restart or an uncertain Bot API response, LVIS does not replay content
  blindly.
- Accepted and permanently rejected deliveries are confirmed so that a stale
  command is not retried later. Only unavailable/capacity conditions are left
  for retry — under webhook by Telegram, and under polling by not confirming
  the update.
- Telegram output is plain `sendMessage` text only. LVIS does not set Markdown
  or HTML parsing, entities, keyboards, callbacks, paid broadcast, threads, or
  link previews.
- Deltas buffered behind an in-flight delivery are compacted from the existing
  safe projection only; adjacent text remains ordered, transient progress
  statuses may collapse, and no more than one Bot API send is launched for a
  paired DM per second. A separate bot-wide pace permits one launch every
  34 ms (about 29 messages per second), keeping below Telegram's approximate
  free bulk-delivery guidance of 30 messages per second.
- Route/session revocation stops queued sends and sends that have not yet been
  handed to Telegram. It cannot recall a request already handed to the Telegram
  Bot API. The bridge guard fences entry to `ConversationLoop.runTurn`, but
  cannot cancel a provider/model turn already executing inside it.
- Only one receiver can hold a bot's updates. If another app or machine is
  already polling, or a webhook is registered, LVIS reports the conflict and
  stops rather than fighting for the stream.
- The adapter uses the bounded safe projection, which cannot judge whether
  ordinary assistant prose is sensitive. Treat Telegram as an external
  recipient accordingly.

Official references: [Telegram Bot API](https://core.telegram.org/bots/api),
[getUpdates](https://core.telegram.org/bots/api#getupdates),
[setWebhook](https://core.telegram.org/bots/api#setwebhook),
[sendMessage](https://core.telegram.org/bots/api#sendmessage), and the
[Telegram Bot FAQ](https://core.telegram.org/bots/faq).
