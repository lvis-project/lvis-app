# Telegram bridge

The Telegram bridge is an opt-in external adapter for one active LVIS main
conversation. It is intentionally separate from the loopback `/v1` API, A2A,
and Tailnet services.

```text
Telegram Bot API
       │ HTTPS webhook (public endpoint operated by the owner)
       ▼
trusted tunnel / reverse proxy
       │ only to 127.0.0.1:46175/telegram/webhook
       ▼
Telegram bridge → restricted platform-bridge command port
       │
safe shared projection → Telegram Bot API sendMessage
```

The initial release supports only explicitly configured personal direct-message
routes. It does not support groups, media, callbacks, bot commands, session
selection, turn cancellation, remote approval, automatic pairing, or automatic
`setWebhook` calls.

## Security model

- It is **not** a Tailnet surface. Telegram is an external cloud service, so
  enabling it is an intentional egress decision for the safe assistant-text
  projection.
- Inbound requests require Telegram's configured `secret_token` header before
  their JSON is parsed. Only private, text-only messages from an exact allowed
  Telegram user ID can reach the common `platform-bridge` command path.
- The host assigns `platform-bridge` provenance. The request cannot claim local
  keyboard trust, a Tailnet role, a session, an attachment, an approval, or a
  cancellation capability. Each tool invocation remains a local, one-shot
  approval decision.
- The route binds to the active conversation captured at app boot. Switching
  conversations, restarting with a changed route epoch, removing an allowed
  user, or stopping the bridge invalidates the route. Change the configuration
  and restart to bind a different conversation in this first release.
- Raw Telegram IDs, messages, bot token, webhook secret, and conversation ID
  are not written to the bridge receipt file. The runtime uses an OS-encrypted
  HMAC secret to derive opaque actor and route bindings. Bot token and webhook
  secret are process environment values, not LVIS settings.
- Inbound deliveries use durable, plaintext-free receipts for seven days. The
  outbound projection is live, bounded, and at-most-once: after a process
  restart or an uncertain Bot API response, LVIS does not replay content blindly.

## Enable the app listener

Supply these values through the desktop app's launch environment or a
service-manager secret facility; never commit them to a repository, shell
profile, Marketplace Compose file, or `.env` tracked by Git.

```text
LVIS_TELEGRAM_BRIDGE=1
LVIS_TELEGRAM_BOT_TOKEN=<BotFather token>
LVIS_TELEGRAM_WEBHOOK_SECRET=<32-256 ASCII chars matching [A-Za-z0-9_-]>
LVIS_TELEGRAM_ALLOWED_USER_IDS=<your numeric Telegram user id[,another-id], no spaces>
LVIS_TELEGRAM_PORT=46175                         # optional fixed loopback port
LVIS_TELEGRAM_WEBHOOK_PATH=/telegram/webhook      # optional exact path
LVIS_TELEGRAM_ROUTE_EPOCH=1                       # bump to fence prior route bindings
```

The listener is off unless `LVIS_TELEGRAM_BRIDGE=1`. It always binds literal
`127.0.0.1`; it cannot listen on LAN or public interfaces. A malformed enabled
configuration fails closed and leaves this auxiliary adapter unavailable while
the desktop app continues booting.

`LVIS_TELEGRAM_ALLOWED_USER_IDS` is the v1 pairing source of truth. It accepts
only canonical positive Telegram numeric IDs, not usernames. A bot cannot
initiate a conversation, so an allowed owner must first send a normal text
message to the bot; only then does LVIS attach that DM to the safe projection.
When more than one owner is configured, they share the one active conversation's
assistant-only safe projection; they are not independent sessions and cannot
select a conversation remotely. `/start` and other slash commands are
intentionally not model commands.

## Public HTTPS termination and webhook registration

Operate a dedicated public HTTPS hostname/path that forwards only to the
loopback listener. Do not expose the app's `/v1`, `/a2a`, Tailnet, or Marketplace
routes through that proxy. The proxy must preserve the raw body and
`X-Telegram-Bot-Api-Secret-Token` header, disable request-body logging and
caching, and enforce the same 64 KiB request cap.

**Fixed-port safety requirement:** do not leave a persistent proxy or tunnel
forwarding to the configured `LVIS_TELEGRAM_PORT` loopback target (default
`127.0.0.1:46175`) unless its forwarding lifecycle is coupled to the bridge
lifecycle. If LVIS stops and the proxy keeps forwarding, another local process
could bind that configured port and receive webhook bodies and the Telegram
secret header. Stop forwarding before or with the bridge, or use a dedicated OS
account/socket ACL that prevents another local process from receiving the
traffic, or an authenticated local relay whose backend binding is itself tied to
the bridge. Without one of these controls, do not operate this fixed-port
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
production bot and makes a public endpoint authoritative. Use
`getWebhookInfo` to verify the URL and inspect delivery errors. Do not add
`drop_pending_updates` unless discarding pending messages is an explicit owner
decision.

If Cloudflare fronts the hostname, give the webhook a dedicated route and
disable browser-oriented JavaScript, Turnstile, and bot challenges on that
route—Telegram cannot solve them. Retain tunnel/origin reachability controls
and the Telegram secret-header check; a challenge bypass must not become a
broad proxy bypass.

The Marketplace Oracle Compose deployment is not the Telegram bridge host and
must not receive the bot token or a generic `/telegram` proxy route. A separate
relay design would be required to bridge that deployment to a desktop app.

## Operational limits

- Accepted and permanently rejected webhook deliveries are acknowledged to
  prevent stale commands from being retried later. Only unavailable/capacity
  receipt conditions receive a retriable response.
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
  handed to Telegram. It cannot recall a request already handed to the
  Telegram Bot API, even if LVIS has not yet received that request's response.
  The bridge guard fences entry to `ConversationLoop.runTurn`, but cannot
  cancel or recall a provider/model turn already executing inside it.
- The adapter uses the bounded safe projection, which excludes reasoning, tool
  inputs/results, local paths, attachments, memory source text, internal IDs,
  and error stacks. It cannot decide whether normal assistant prose is sensitive;
  treat Telegram as an external recipient accordingly.

Official references: [Telegram Bot API](https://core.telegram.org/bots/api),
[setWebhook](https://core.telegram.org/bots/api#setwebhook),
[sendMessage](https://core.telegram.org/bots/api#sendmessage), and the
[Telegram Bot FAQ](https://core.telegram.org/bots/faq).
