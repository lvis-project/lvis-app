# MCP Resources — consumption policy

Status: design frozen, implementation staged.
Scope: `resources/list`, `resources/read`, `resources/templates/list`,
`notifications/resources/list_changed`. Excludes `resources/subscribe`
(deliberately — see §7).

## 0. Why this exists

LVIS consumes MCP **tools** and, since the prompt work, MCP **prompts**. It does
not consume **resources** at all: `resources/read` exists in the client but only
for the `ui://` scheme, which is the MCP-Apps extension, not the core capability.
`resources/list` appears in the governance capability map and is never called. So
a server can publish a schema, a document, or an issue and the user has no way to
put it in front of the model except copying it by hand — the exact gap the prompt
work closed for its own primitive.

## 1. Who chooses — and why that answer

The spec is explicit that resources are **application-driven**: the host decides
how context gets incorporated, and the canonical illustration is a resource
picker. It is NOT a model-controlled primitive like tools, and NOT a
user-invokes-then-server-authors-the-turn primitive like prompts.

Reference-host check (required before freezing a provenance design — the spec text
alone has misled this project before): Claude Code exposes resources two ways at
once.

1. `@server:protocol://path` mentions in the composer, autocompleted alongside
   files, "automatically fetched and included **as attachments** when referenced".
2. "Claude Code automatically provides tools to list and read MCP resources when
   servers support them" — i.e. the model can also enumerate and read.

Both, not either. LVIS follows the same split, because they answer different
questions: the mention is how a person says "consider this", the tools are how the
model follows a reference it discovered mid-task.

## 2. The provenance decision

A resource is **untrusted server-authored data attached to a turn**, not a staged
turn origin.

This is the one design question worth stating explicitly, because the staged-origin
table (`shared/staged-origins.ts`) is right there and reusing it would be the easy
move. It would also be wrong. A staged origin means *the turn's input was placed by
a non-user actor* — the whole message is theirs, so the turn runs with force-ask on
and the user's own authorship revoked. A resource attachment is the opposite: the
user wrote the message and pointed at some data. Marking that turn `plugin-emitted`
-style would force-ask every write for a turn the user genuinely authored, and
would teach users to click through the gate — weakening the mechanism where it
does matter.

What the resource DOES get:

- an untrusted fence, so the model can tell data from instruction. Reuses the
  `mcp-app-context` framing already used for app-published state: fenced,
  `trust="untrusted-metadata"`, with guidance that imperatives inside are data.
- a `FenceTag` entry (`mcp-resource`) so the closed union keeps its compile guard,
  and `neutralizeFenceClose` so a body cannot escape its own fence.
- bounded size and count, per §5.
- an audit row naming server + URI + byte count.

Tool-call provenance for the turn stays the user's. That is correct and it is not a
gap: the untrusted framing is what carries the trust signal, exactly as it does for
`mcp-app-context` today.

## 3. Discovery

At connect, after `tools/list` and `prompts/list`:

- gate on the server having **advertised** `resources` in its capabilities AND the
  capability being approved by governance — the same two-key gate `prompts/list`
  uses; an unadvertised or unapproved capability means no request leaves the host.
- paginate with the same bound as prompts (`MAX_RESOURCE_PAGES`), so a hostile
  `nextCursor` loop cannot hang the handshake.
- **sanitize at the wire boundary.** The declared TS types are casts, not checks.
  Each entry keeps `uri`, `name`, optional `title`/`description`/`mimeType`, and
  `size` only when they are the right type and within bounds; anything else is
  dropped there, so one shape reaches every consumer. This is the lesson from the
  prompt work, where a non-string `name` would have thrown when React rendered it.
- URI validation is a host-side allowlist of schemes, not a regex over the whole
  string: `file:`, `git:`, `https:`, and server-custom schemes are permitted as
  OPAQUE identifiers — the host never resolves them itself. `ui:` is reserved for
  the MCP-Apps extension path and is excluded here so the two never cross.

`resources/templates/list` is discovered the same way but is **display-only** in
stage 1: a template is a URI pattern the user must fill, which is the argument-form
problem the prompt dialog already solved, and it belongs in the same stage as the
mention UI rather than the plumbing.

`notifications/resources/list_changed` re-runs discovery, debounced, and only for a
server that declared `listChanged`.

## 4. Reading

`resources/read` returns `contents[]`, each either `text` or base64 `blob`.

- **text only.** A `blob` becomes an explicit placeholder naming its mimeType and
  byte count, never silently dropped and never decoded into the turn — same rule
  the prompt renderer follows for image/audio blocks.
- the read is gated on the URI having been **listed** (or matching a listed
  template, once templates land). A URI the host never saw is refused before the
  request, so a model cannot use `resources/read` as a general fetch primitive
  against the server's URI space.
- `https:` resources are NOT fetched by the host. The spec says servers should use
  that scheme only when the client can fetch it directly; LVIS does not, because
  host-side fetching of a server-chosen URL is an SSRF primitive. Such a resource
  is listed and reading it returns a code the UI explains.

## 5. Bounds

Mirrors the prompt bounds, and shares the module where the numbers overlap:

| Bound | Value | Why |
|---|---|---|
| catalogued resources per server | 200 | the picker is a list a person scans |
| rendered text per read | 32 KB | larger than a prompt because a resource IS the payload |
| contents blocks per read | 32 | a read is one document, not a conversation |
| attachments per turn | 8 | keeps a mention storm from filling the window |
| URI length | 2048 | audit rows and labels interpolate it |
| name / title / description | 128 / 128 / 512 | host chrome renders them |

Every one of these is enforced in main, and the UI uses the same constants from a
shared module so a field the user can fill is never one main drops.

## 6. Surfaces

Stage 1 — plumbing (no UI): discovery, sanitization, bounded read, governance
gating, audit. Exposed to the renderer through the existing `mcp:servers` state so
the picker work has data to build on.

Stage 2 — the model path: `mcp_resource_list` / `mcp_resource_read` builtin tools,
categorized `read` (never `write`), subject to the ordinary permission gate. Their
output is a `tool_result`, NOT a fenced block: that is the channel every tool
result already uses, the model reads it as data it fetched rather than as context
the host injected, and adding a second framing for one tool would make the fence
mean less everywhere else. The fence belongs to stage 3, where resource text is
attached to a USER turn and therefore does enter the prompt as context.

Because these builtins hand the model untrusted server content, they declare
`requiresMcpScope`, so the turn scope's `includeMcp` switch applies to them as it
does to MCP tools. Without it a builtin badge would be a way around the decision
that headless (routine) loops run with no MCP surface.

Stage 3 — the user path: composer mention (`@server:uri`) resolving through the
same read, attached to the turn as a fenced untrusted block, plus templates.

Stages land as separate PRs. Stage 1 touches no cluster-sensitive path; stages 2
and 3 do (`src/tools`, `src/ipc`), so they carry the 3-role attestation.

## 7. Deliberately excluded

- **`resources/subscribe`.** A subscription is a server-driven push into a live
  session — the channel-style surface, with its own re-entrancy and rate questions.
  It is not needed to close the consumption gap and it would be the only
  server-initiated context write in the app; it gets its own design if it is ever
  wanted.
- **Binary content in the turn.** Placeholder only, per §4.
- **Host-side `https:` fetching.** Per §4, SSRF.
- **Resource-derived tool provenance.** Per §2, the turn stays the user's.

## Security invariants

- No `resources/*` request leaves the host unless the capability was advertised at
  discovery AND approved by governance; unclassified methods fail closed.
- `resources/read` accepts only a URI the host listed; the URI is an opaque
  identifier the host never resolves.
- Resource text is bounded wherever it enters the host, and the shape it enters in
  depends on the surface: a `tool_result` for the model path (stage 2 — the channel
  every tool result uses), and an untrusted FENCE with the body's own closing tag
  neutralized for the user path (stage 3), because that one becomes prompt context.
- A resource can never carry tool authority: it is data in the turn, and the
  permission decision belongs to the turn's real origin.
- Wire fields are validated at the client boundary, so one shape reaches main, the
  renderer, and the audit log.
