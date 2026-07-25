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
- URI validation is a host-side allowlist of schemes PLUS a character exclusion over
  the whole string. `file:`, `git:`, `https:`, and server-custom schemes are permitted
  as OPAQUE identifiers — the host never resolves them itself. `ui:` is reserved for
  the MCP-Apps extension path and is excluded here so the two never cross. The
  characters RFC 3986 excludes from a URI (space, `"`, `<`, `>`, `\`, backtick, `^`,
  `{`, `}`, `|`) are refused outright, so no consumer has to escape them: the same
  string is printed into a fence attribute, a tool result, an audit line, and soon a
  picker, and one of those already let a `">` in a URI break out of the fence. A
  legitimate URI percent-encodes them, so nothing expressible is lost — but note the
  consequence for stage 3b: an RFC 6570 template (`file:///{path}`) is rejected by
  this rule, so templates need their own predicate rather than a flag on this one — and
  the same applies one level up: a template's identity field is `uriTemplate`, not `uri`,
  so a picker item's `uri` would be a lie for one, and handing a brace-string to
  `isUsableResourceUri` refuses it into the generic-failure bucket.
- The same rule also refuses INVISIBLE and text-reordering characters (bidi overrides
  and isolates, zero-width, the default-ignorable set). A URI is an identifier, and one
  carrying `U+202E` renders `annual-<RLO>gnp.exe` as `annual-exe.png` while a zero-width
  space makes two different resources render identically — a user cannot tell which row
  they clicked. Refusing at the boundary rather than normalizing per consumer is forced
  by one consumer that CANNOT normalize: the audit row is a forensic record, and
  rewriting it would falsify it. Deliberately NOT the whole non-ASCII range — a
  filesystem server publishing a CJK or Hangul path is honest and common — but it is not
  "any non-ASCII is fine" either: the class is shared with the display sanitizer, so a
  name carrying an emoji variation selector or a ZWJ sequence is refused too. That is an
  ACCEPTED COST of one definition rather than two policies, and the boundary test pins it
  as an expected refusal so nobody later reads it as a bug. Display
  strings (`name`, `title`) are prose and take the opposite treatment: every codepoint
  is legitimate in them, so they are normalized at the render site instead.

`resources/templates/list` is discovered under the SAME two keys and the same
`resources` capability — a separate capability would ask the user a question they have
already answered. It landed with the mention UI rather than with the plumbing, because
a template is a URI pattern the user must fill and a catalogue nothing can render is
just a liability.

Templates get their own predicate (`shared/mcp-resource-template-bounds.ts`), and it is
**RFC 6570 Level 1 only** — `{var}`, no operators, no modifiers, no explode. That is not
a shortcut around the spec; it is the property the read path rests on:

  - Level 1 expansion percent-encodes everything outside the unreserved set, so a user
    typing `../../etc/passwd` produces one segment, not a traversal. `{+var}` is defined
    as RESERVED expansion, which does NOT encode `/` — accepting it would hand the server
    exactly that traversal, chosen by whoever is typing.
  - a value can never introduce URI STRUCTURE: `/`, `?`, `#`, `:` and `@` all encode, so
    what the user types stays inside the component the server put the variable in.

A server publishing an operator is refused at discovery and appears nowhere, which is the
fail-closed direction: an un-offered template costs a feature, an un-encoded one costs a
read outside what the server meant to publish. The predicate is written by REMOVING every
well-formed expression and validating the literal skeleton with `isUsableResourceUri`, so
the two rules cannot drift — a template cannot smuggle in a scheme or an invisible
character that a plain URI could not.

What Level 1 does **not** buy is a fixed scheme, and an earlier version of this section
said otherwise. A server may publish `{scheme}://host/{path}`: its skeleton `x://host/x`
is a legal server-custom scheme, so it catalogues, and the user picks the scheme —
percent-encoding is no help, because `javascript` and `ui` are already unreserved. Two
things hold instead, and both run on the EXPANSION rather than on the pattern: the
ordinary URI predicate re-validates the finished string, which is where a reserved scheme
dies, and the client re-derives the `https:` refusal from it. That is also why the
discovery-time `hostFetchRefused` flag on a template is display-only — it answers the
literal-scheme case for the picker, and the read never consults it.

`notifications/resources/list_changed` is **not handled** — no listener exists for it in
`src`, for resources or for templates. An earlier version of this line described a
debounced re-discovery as if it were implemented; it never was. Until it is, a catalogue
is what the server declared at connect, and a server that adds a resource mid-session
does not appear until the next connection. Corrected rather than deleted, because "we
consume the notification" is the kind of claim someone plans against.

## 4. Reading

`resources/read` returns `contents[]`, each either `text` or base64 `blob`.

- **text only.** A `blob` becomes an explicit placeholder naming its mimeType and
  byte count, never silently dropped and never decoded into the turn — same rule
  the prompt renderer follows for image/audio blocks.
- the read is gated on the URI having been **listed**. A URI the host never saw is
  refused before the request, so a model cannot use `resources/read` as a general fetch
  primitive against the server's URI space.
- a TEMPLATE read is gated on the **template**, exact-matched against what the client
  listed, and the host produces the URI itself. This is deliberately not "expand in the
  renderer, then check the URI against a pattern": that check needs a matcher, and a
  matcher for `file:///{path}` accepts `file:///../../etc/passwd`. Exact-matching the
  pattern and expanding host-side is the version that cannot be got wrong. The `https:`
  refusal is re-derived from the EXPANSION rather than inherited from the template,
  because a template's literal scheme is not necessarily its expansion's.
- a missing or blank value is a refusal, not an empty substitution: expanding `{path}` to
  nothing points at the directory above — a different resource than the user asked for,
  and one they cannot see they asked for.
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
| template variables | 8 | a form a person fills, not a payload |
| template value length | 512 | bounded before it becomes part of a URI |

Every one of these is enforced in main, and the UI uses the same constants from a
shared module so a field the user can fill is never one main drops.

The composer's own `ATTACH_MAX_COUNT` (5) is a SEPARATE lane and resources do not count
toward it: that number bounds how many chips stay legible side by side, while this one
bounds how much server text a turn carries. Folding them would mean five attached
documents stops the user adding a screenshot, and would make the bound above unreachable
from the only surface that produces resource attachments.

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

**Templates are deliberately NOT on the model path.** The expansion would still be
host-side and still percent-encoded, so this is not a containment gap — it is a reach
decision. A listed resource is a finite set the server chose to publish; a template is a
FAMILY, and handing the model one turns "read what this server published" into "read
anything matching this shape", with the model choosing the values. That is a wider reach
than stage 2 was argued for, and it should be argued for on its own rather than arriving
as a side effect of the picker work. Recorded here as a non-goal, not an omission.

Stage 3 — the user path, split at the process boundary the way stages 1 and 2 were:

  - **3a (landed):** `lvis:mcp:attach-resource` reads a declared resource and
    returns the fenced block to attach. The HOST builds the fence — never the
    renderer — because this text lands beside the user's own words, which is the one
    place the model has the most reason to read it as the user speaking. The
    per-turn cap is enforced in main, not in the composer: the renderer decides what
    to offer, main decides what a turn carries. `McpManager.listDeclaredResources`
    is the one projection for callers that need the catalogue as a list (the model
    tools today); the attach path deliberately does not use it, so the listed-URI
    check stays in one place inside the client instead of being copied into the
    handler.
  - **3b (landed):** the composer `@` mention with autocomplete, and templates. The
    picker offers both kinds of row from one catalogue (`lvis:mcp:list-resources` and
    `lvis:mcp:list-resource-templates`, fetched together — two effects would each set the
    catalogue and the later one would erase the other's rows). A resource row attaches; a
    TEMPLATE row opens a host dialog, because a template is an offer rather than an
    identifier. The dialog collects values only; it never composes a URI.
    `lvis:mcp:attach-resource-template` takes the template plus the values, and main
    expands, reads, and fences — keyed on the URI IT produced, which it hands back for the
    chip's label. That echo is safe because no channel accepts an **unlisted** URI, not
    because none accepts a URI: `attach-resource` takes one, and an expansion replayed
    through it meets the listed-URI gate inside the client, which the expansion was never
    in. Values cross the boundary as a plain object and become a `Map` immediately,
    so a variable named `__proto__` or `toString` is an ordinary key rather than an
    inherited slot. Both attach channels share the user-initiated rate bucket with
    `prompts/get`: one server, one budget for round-trips the user asked for.

The per-turn cap lives at the turn-entry chokepoint (`runStreamedTurn`) because
`chat send` and `sidechat send` parse their payloads separately, so a bound in one
would not exist for the other, and that is the one place attachments enter a turn. It
counts fence OCCURRENCES in the attached parts, so the bound is a property of what was
attached rather than of how the renderer packaged it — a composer that joins several
attachments into one part cannot spend more than the budget — and it REFUSES the turn
rather than trimming, because dropping the extras would leave the model answering from
fewer documents than the user believes it read.

Two things follow from counting ATTACHMENTS rather than all of a turn's text, and both
are decisions rather than omissions:

  - The user's own message text is never counted, even though a fence pasted there is
    indistinguishable from a host-built one. Counting it looked stricter and was worse:
    a refusal is only ever explainable when the host built the material, and a
    developer pasting an LVIS transcript excerpt — which contains these fences verbatim
    — would otherwise be told to remove resources they never attached, with no way to
    discover why. A fence a user types frames their OWN words as less trusted, so it
    buys a forger nothing. It also kept the refusal off the replay paths, which matters
    more than it looks: `retryEffort` truncates history BEFORE streaming, so a throw
    there would leave a conversation permanently shortened.
  - Stage 3b therefore carries a hard constraint: **a mention must resolve to an
    attachment part**, never to text spliced into the user's message. That is the one
    field this bound does not measure, so 3b lands with a test that fails if the
    composer inlines a fence — a comment will not hold it.

    This constrains the WIRE shape, not the UI. The reference-host precedent in §1 is an
    inline `@server:uri` mention, and that stays available: the composer may render an
    inline chip while the material it sends rides as its own part, which is how
    attachment chips already work. Only conflating the two creates a conflict.

    And if 3b finds the part-only rule genuinely fighting the UX, the answer is NOT to
    widen the count back over the message text — that reintroduces both the false
    refusal and the history-truncating replay. It is to stop pattern-matching provenance
    altogether: have `attach-resource` return a handle, let the renderer pass it back,
    and have main resolve and count what IT built at send time. That makes the bound
    structural and retires the forgery and false-positive questions together. Written
    down here so the next person reaches for it instead of the input count.

The bound interacts with the user-initiated MCP rate bucket that prompts and attachments
share, which had to grow once attaching stopped being one click per call — at a flat 20,
three full-attachment turns in a minute hit `rate-limited` mid-turn. The bucket is NOT
derived from this bound, though it was briefly: it is a ceiling on requests to somebody
else's server, while this is a budget for our own context window, and deriving it meant a
change to our window budget silently re-deciding how hard a server can be hit. The
relationship is checked by a test instead, so moving either one forces a look at both.

The fence is `<mcp-resource trust="untrusted-server-data">`, registered in the
`FenceTag` union so its builder had to answer the escape question. Inside the fence
the body's own closing tag is neutralized (it cannot end the region and continue
outside it) and so is any opening tag (it cannot forge frames, which would let one
hostile resource spend the whole per-turn budget and refuse the user's send). Neither
rule requires a well-formed tag: `</mcp-resource` alone is neutralized, because a rule
that waited for the closing bracket was both quadratic on unterminated tags and — once
the span between was bounded to fix that — escapable by padding the close tag past the
bound. The consumer is a model reading prose, so "looks like a tag" is the standard, and
that makes tag-name matching the whole rule.
Attribute values printed into the open tag go through the same module's
`fenceAttrValue`, because an attribute carrying `">` is the other way out of a fence.
A clip is admitted in a line the model reads rather than a flag the UI could ignore.

Stages land as separate PRs. Stage 1 touches no cluster-sensitive path; stages 2
and 3 do (`src/tools`, `src/ipc`), so they carry the 3-role attestation.

### Open decision: PII redaction does not reach an attached resource

`sanitizeOutgoingInput` (the `piiRedactEnabled` toggle) is applied to the turn's INPUT
text only; content parts pass untouched. Before the mention UI existed no renderer path
produced a text part, so nothing text-bearing escaped redaction — a resource read is the
first, and it can carry up to a read's worth of the user's own documents per attachment.

The inconsistency is what makes this worth deciding rather than assuming: the SAME bytes
pasted into the composer ARE redacted, because a paste is inlined into the input.

Not resolved here, deliberately. Redacting inside the fence means the host rewriting
content the fence exists to attribute to the server, and the per-turn cost is real
(8 attachments x 32 KB through the pattern set). Leaving it means a privacy toggle that
silently stops applying when the user types `@`. That trade belongs to whoever owns the
DLP surface, not to the composer PR that made it reachable.

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
