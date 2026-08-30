# Tiled chat groups — up to four main conversations

## What this is

The main area holds up to **four** main-chat conversations side by side, each
able to stream at the same time. Chat mode holds exactly one.

The ceiling is not decorative. A conversation **is** a `ConversationLoop`: the
loop owns the live history and runs exactly one turn at a time. Four tiles that
can each be streaming therefore means four loops, not four views of one. Every
control that today addresses "the conversation" has to say **which** one.

## The name

The group id travels as **`chatGroupId`**. The stream protocol already has a
`groupId`, and it means *tool-call group* — an unrelated concept on the same
frames. Reusing that name would produce a silent collision where a frame routes
to the wrong tile only when a turn happens to contain grouped tool calls.

`MAIN_CHAT_GROUP_ID = "main"` is the primary group, and it is the loop that
already exists. `MAX_CHAT_GROUPS = 4` is the ceiling, counted **including** the
primary.

## What is per-group and what is not

Per **group** — one per tile:

- the `ConversationLoop` itself (live history, the single in-flight turn)
- its post-turn hook chain (turns must be attributed to the session that tile
  is holding, not to whichever session another tile happens to hold)
- its rationale bindings
- its conversation surface runtime, command port, and legacy stream adapter —
  two tiles sharing one timeline would interleave their frames

Per **window** — shared, and deliberately not multiplied:

- `memoryManager` — every tile is an ordinary main-chat session and belongs in
  the same session list
- `idleScheduler` and `memoryCaptureService` — these fire once per window.
  Giving each tile its own copy would multiply idle maintenance by the number
  of open tiles. This is the same reasoning the side chat already follows.
- the session list, search, starred, export/import — these describe the
  window's conversations, not any one tile's

## Channel split

`lvis:chat:*` divides cleanly along that line.

**Per-conversation — must carry `chatGroupId`:**
`send`, `abort`, `guide`, `new`, `fork`, `retry-effort`,
`continue-last-user`, `edit-resend`, `compact`, `session-resume`,
`get-history`, `get-verbatim-tool-result`, `get-sub-agent-transcript`,
`enter-checkpoint-view`, `exit-checkpoint-view`, `branch-from-checkpoint`,
`has-provider`, `group-release`

**Window-scoped — unchanged:**
`sessions`, `session-history`, `session-update`, `session-delete`,
`export`, `import`, `get-write-diff` (reads a sidecar by session id),
`main-active-state` (the conversation the next launch resumes — the primary
tile's; a turn in another tile does not move it)

`chatGroupId` is **required**, not defaulted. Both sides of this channel ship
in the same binary, so a default would only ever paper over a caller that
forgot to say which tile it meant — and the symptom of that bug (a turn
appearing in the wrong tile) is worse than a rejected call.

## Geometry: a split tree, not a list

Tiles are arranged **freely, tmux style**: any leaf can be split horizontally or
vertically, so 1, 2, 3, and 4 are all reachable in more than one shape and the
user picks which. The layout is therefore a **tree** of splits whose leaves are
chat groups, not a flat list.

Two facts settle this.

`DESIGN.md` makes **448px** the narrowest width any surface must work at — the
side panel's `SIDE_PANEL_MIN_WIDTH`, and the mobile-class baseline — so that is
the floor a tile inherits. The main area is roughly 1000px wide with the sidebar
open, so four columns give each tile 250px, under that floor. Four tiles have to
nest. Once the layout nests at all, a flat list cannot describe it.

The work panel is a raised card with the floating sidebar's insets and
rounding at every size — one kind of overlay surface in the window — carrying
its own tabs and its own close, so the group header stays the conversation's
line: title, its actions, and the tile controls (panel, split, show-alone,
close the tile). The card is as tall as the tile and stands beside the header,
not under it: the frame lends it a slot that is the tile's own flex child, and
the view portals the card there. So the header's × closes the conversation
tile and the card's × closes the panel — two closes, each owning one thing. A
tile with room for the card beside a usable transcript (at least the card's
reserve plus 320px) docks it as a column that pushes the transcript; a
narrower tile floats the same card over the transcript's right edge **inside
the tile**, never a window-level sheet, the transcript keeping its layout
underneath — and, floating, it covers the header row too, its own strip taking
over. The mode comes from the container hook's hysteresis verdict so a gutter
dragged across the threshold does not flip it.

When the card has no tab open, its launcher shows the conversation's tool
activity — the six counters and the items by category, the same body the
header's tool-activity popover shows — so an empty panel still reports on the
conversation, and its items open the very tabs the picker offers.

Which way a tile is halved is the user's call: the header's split control
drops two buttons — beside the chat, under it — rather than guessing from the
tile's shape, and a direction whose halves would fall under the tile floors
(448px wide, 280px tall) is offered disabled — with a one-line reason when
neither fits — so the limit reads in the control instead of arriving as a
rejection. Dropping a conversation on a tile's edge answers to the same floors:
an edge that would not fit lands in the centre.

The window's chrome rows — title band, sidebar cluster strip, group headers —
take their heights, their lead clearance past the OS lights, and the insets
that line the chat group's bottom edge up with the sidebar card's from px
tokens (`--chrome-band-height` and kin in `styles.css`), never rem: those
measurements sit on the OS traffic lights' line, which is drawn in device px,
and the user's type scale must not move them off it. Glyph sizes inside the
controls still follow the type scale.

An empty tile lifts its composer by a share of the tile's own chat column
(`cqh`), not of the window: a tile that is half the window tall centres in its
own half.

Once split, every tile can be closed — the primary included, whose loop main
keeps and hands a blank conversation on release — and any tile can be shown
alone: maximizing hides the others without closing them, the way chat mode
does, and restoring gives them their places back.

The addressability objection that argued for a flat list does not survive
contact with the actual split: a leaf keeps its stable `chatGroupId` no matter
where it sits, and the tree describes **geometry only**. Nothing that names a
conversation — a keyboard command, a restore, a test — has to name a position.

```
tree := { kind: "leaf", chatGroupId }
      | { kind: "split", axis: "row" | "column", children: tree[], sizes: number[] }
```

`MAX_CHAT_GROUPS` is a count of LEAVES, unchanged at 4. The tree's depth is
bounded by that count, so no separate depth limit is needed.

## Placement: drop on a tile's edge

A session is dragged from the session list onto a tile. The **edge** it lands on
is the instruction:

- an outer band on any of the tile's four sides → split that leaf on that axis
  and put the session on that side
- the tile's centre → replace what that tile is holding

The band is 40px, but never more than 30% of the tile: a fixed band on a narrow
tile would leave no middle at all, turning "replace" into a target the user
cannot hit. On a corner the *nearest* edge wins, so a pointer moving one pixel
does not flicker between two answers.

This is the same gesture editor groups use elsewhere, so it needs no teaching,
and it is the only drop model where the *shape* the user wants is expressed by
where they let go rather than by a separate control. At `MAX_CHAT_GROUPS` every
edge resolves to the centre — the tile highlights whole rather than by halves,
so the ceiling is felt while still dragging instead of arriving as a rejection
after the fact.

The session cannot be loaded in the drop handler, because the tile it belongs in
does not exist yet: the drop creates a leaf, and that leaf mounts a render later.
The window remembers the pair and delivers it the moment that tile publishes its
handle to the registry — which is also why the registry exposes `subscribe`
rather than only a read.

## Resizing: the gutter between two tiles

A boundary between two sibling tiles is a gutter. Dragging it moves that one
boundary: the tile before it grows or shrinks along the split's axis, and the
tile after it takes whatever is left of the pair.

The bar on the gutter is `EdgeResizeBar`, the one control the sidebar and the
side panel already resize with. That control thinks in terms of one panel with
one width; on a gutter, the tile before the boundary plays the panel and its
extent along the axis plays the width. The hook gained one option for it,
`axis`, because a boundary between a top and a bottom tile follows the
pointer's Y. Sign, clamp, keyboard steps, Home/End and double-click reset are
the same code either way — which is the point of it being an option rather
than a second hook.

A split has no id, so a gutter is named by its position: the path of child
indices down to the split that owns it, plus the index of the pair it sits
between. `ChatGroupGutter.key` is that position written as a string — it is
how the DOM addresses a gutter, and it survives a resize because a resize
changes shares, not shape. Either side of a gutter may itself be a split.

Moving a gutter changes the two shares it separates and nothing else. The
other siblings, and everything nested inside either side, keep their own
proportions, so a drag on one boundary never moves a boundary the user was not
holding.

The floors are pixels: 448px across — `SIDE_PANEL_MIN_WIDTH`, the narrowest
width DESIGN.md holds any surface to — and 280px down. The tree only knows
shares, so the bar converts through the measured canvas. A pair that cannot
hold two floors offers no bar at all, rather than a bar that snaps back on
every drag.

During a drag the new layout is written straight to the cells' style, the
same DOM-direct path the sidebar uses, and the tree is committed once on
release. Committing per move would re-render every conversation on screen
for every pointer event.

## The pieces

Each piece is independently shippable and independently verifiable.

### Main process: group-addressable loops

1. `resolveChatGroupLoop(chatGroupId)` in `boot/steps/conversation-wiring.ts`:
   a lazy `Map<string, ConversationLoop>` over the shared memory manager,
   enforcing `MAX_CHAT_GROUPS`. **Done.**
2. `src/ipc/domains/chat.ts` builds a memoized `chatGroupContext(chatGroupId)`
   — loop, command port, surface runtime, legacy adapter, **and the turn
   machinery** (leases, stream ids, sinks, and the edit/continue/retry replay
   paths). Every per-conversation handler resolves its group from the payload
   and reaches turns only through it. The replay paths were once one closure
   family over the primary loop; a handler that read a group's history and
   replayed it through those ran that tile's turn in the primary conversation.
   **Done.**
3. `group-release`: closing a tile sends it, and main stops any running turn,
   detaches the group's frames, and forgets the loop. Ids are never reused, so
   without this a closed tile would count against `MAX_CHAT_GROUPS` for the
   rest of the session. Release is tied to **close**, not unmount — the
   chat-mode toggle unmounts tiles too, and must not destroy anything. A
   renderer that navigates (reload) or dies releases every group at once:
   the one that comes back numbers its tiles from the start, and must never
   meet a context the previous renderer left behind. **Done.**

### Channels: frames say which tile they belong to

`platform-conversation-legacy-adapter.ts` `deliver(envelope)` already has
`envelope.conversationId`. Stamp `chatGroupId` onto every frame there — one
insertion point, so no frame can escape unlabelled — and have the renderer drop
frames addressed to another group.

### Renderer: conversation state per group

`<ChatGroupSession>` owns one tile's conversation: `useChatState`,
`useWorkflowTools`, `useCurrentSession`, `useSendMessage`, the context budget,
the cost estimate, the composer draft and attachments, and every per-turn
handler. Every hook there is keyed on the tile's group-bound api, so mounting
it twice gives two conversations that stream at once.

`useSessions` split into `useSessionList()` — the window's list, the same for
every tile — and `useCurrentSession()`, which answers about ONE tile.

What stayed in the window, and why: the status bar (a toast about a project
error is the window's news), search (the panel is an overlay over everything,
reading the transcript on screen), export (it takes an explicit session id),
and the session list. The window reads the focused tile through
`chat-group-session-registry.ts` rather than through props — every control that
names "the conversation" means the tile the user is looking at, and reading it
in one place is what keeps that meaning single.

Two rules the tiles must keep:

- **The conversations stay mounted across view navigation.** A tile subscribes
  to its group's stream when it mounts, so unmounting the surface to render
  Settings drops the frames of a turn still running — and takes the composer
  draft and scroll position with it. The router hides it instead.
- **Stream accumulators advance at frame time, not inside a state updater.**
  React runs an updater at flush time, so a ref mutated in one only catches up
  when React re-renders. Two frames landing in the same tick then read a stale
  (or already-cleared) accumulator, and a finished turn renders a blank body.

### Cards belong to the conversation that asked

A tool-approval card and a user-question card are raised by ONE turn, and a
turn runs in one tile. Both render inside that tile's conversation column —
over its own composer, in front of its own transcript — and nowhere else.
With three tiles open, a card raised by the middle one leaves the other two
exactly as they were: no backdrop, no dimmed surface, no focus steal, their
composers accept input and their turns keep running. This is what
`data-approval-scope` marks: the element a dock is allowed to affect.

The routing is one rule, `sessionOwnedBy`, applied by two readers:

- **Questions** arrive on the window-wide `lvis:ask-user:request` channel;
  `useWorkflowTools` keeps the ones whose `sessionId` the tile owns (its own
  session, or a sub-agent it spawned) or draws (a session no tile holds that
  the focused tile adopted). The card is `QuestionOverlay` inside the tile's
  composer dock.
- **Approvals** arrive on the window-wide `lvis:approval:request` channel into
  the window's one FIFO (`useApproval`). Every drawing surface CLAIMS the
  sessions it owns — a tile through the same `ownsSession` predicate its
  stream subscriptions use, a side chat its own loop's session — and reads the
  queue for those requests. `ApprovalDock` renders them per surface, head
  first, and answers through the window's `decide(requestId, …)`, so the
  signed response path (request id + nonce + HMAC) does not change with where
  the card is drawn. The ask a sub-agent spawn raises is one of these
  approvals (`agent_spawn` asks by contract), so the spawn card follows the
  same rule: it is drawn in the tile whose turn is spawning.

What no surface claims has one explicit home, the window's own dock: a
request that names no conversation (a host or plugin ask), or a session no
open surface holds (a tile maximized away while its turn asked). That dock
draws only unclaimed requests; it is those requests' home, not a catch-all
behind the tiles. It has a `data-approval-scope` of its own, beside the tiles
and an ancestor of none — so an unclaimed card covers no tile's composer and
takes no tile's caret. The invariant, then: a `data-approval-scope` contains at
most ONE composer, the one its dock may cover.

The window's dock is a **band**, not a float: a flex sibling below the route
canvas, so the space it takes is space the tile grid does not get. Over a
conversation the float is right — the card covers that surface's own composer,
which that surface inerts anyway. The window has no composer of its own and
every composer on screen belongs to someone else, so floating there left `inert`
and the caret correct while still winning the hit-test at a tile's textarea:
keyboard-reachable, not mouse-clickable. Position follows the same rule the
scope does — a surface may only take space from itself.

That band is the window's whole surface, not the dock's alone: the unclaimed
approval dock and the window's own overlay cards stack inside it and share one
budget. Anything the window has to show has the same problem and takes the same
answer — a second float, anchored top-right, would land on the rightmost tile's
own lane and take clicks meant for it.

Because a band takes its height out of the grid, its cap comes from the grid's
own arithmetic rather than from a share of the viewport: the shortest tile must
still clear `CHAT_GROUP_MIN_HEIGHT` plus the cell inset and the tile row's
bottom gutter — the floor a split or a gutter drag already holds it to — and the
band gets what is left, down to `WINDOW_DOCK_MIN_HEIGHT`, below which the card
scrolls inside itself instead of taking more. A fraction of the window would be
comfortable above one tile and starve four: measured at 1243x768 with a 2x2
holding an unclaimed request and a window card, an uncapped band grows to 590px
and leaves 59px frames with no transcript at all, while the cap holds the band
at 144px and the frames at 282px. The cap is a ceiling, not a size: with one
short card the band settles at 112px on its own and the frames keep 298px.

`CHAT_GROUP_MIN_HEIGHT` is the measured floor, not a round number: it is the
frame height at which a tile still holds a header, a composer, AND one visible
turn. Shrinking the window with one tile up, the turn goes first — at a 290px
frame the transcript viewport is 11px, at 270px it is 0 and the composer starts
overflowing its column. 280px is where all three still fit. The floor lives on
what the tile contains, so it moves when the composer does rather than when the
window does, and the band's cap moves with it.

A headless or routine turn is **not** a source of cards here. It has no
interactive approver by construction: the reviewer's headless lane answers
`low → allow` and anything above it `deny` (`PermissionManager.resolveReviewerDecision`),
so it never parks a request for a human. What actually populates the window's
dock is therefore host and plugin asks that name no conversation, plus cards
whose conversation left the screen while the ask was parked.

The second kind used to stay forever. A card is normally taken down by the turn
that asked it, and a tile that closes retires its parked ask host-side
(`cause="tile closed"`) — but the surface that would have dropped the card has
unmounted, so nothing renderer-side ever learned. The host therefore announces
every settlement on `lvis:approval:settled`, and the window's one queue
reconciles: a request that is no longer answerable leaves, wherever its card was
drawn. Announced for every settlement rather than a chosen subset, because the
renderer already dropped the ones it answered itself and a closed list of
announced causes would be a second thing to keep in step with the gate's
`settle`. A request whose own answer is in flight is left to that answer.

The two unowned cases split on purpose. An unowned question is adopted by the
focused tile at arrival: an answer needs a conversation to land in. An unowned
approval goes to the window's dock: its answer needs none. An unowned overlay
card takes the second road too — see below.

The card names the conversation by the surface's own label — the tile's title,
"Side chat", "Conversation not open in any tile" — and keeps the raw session
id in the review details, where an identifier is useful.

While a tile's turn is parked on an approval, a band above its composer says
which tools are waiting, and its message queue says it is held by the
approval. If the host settles the ask without an answer (timeout, cancel),
the turn's `done` puts a system entry in that tile naming what was blocked and
drops the dead card. A renderer reloaded mid-approval reads the parked
requests back (`lvis:approval:pending`) and the card reappears in the tile
holding that session — the primary conversation's, whose turn a reload does
not stop. Every other tile is let go of when the renderer navigates (the chat
domain's renderer-lifetime watch), and letting go stops its turn, which
retires the ask it was parked on: the audit row says `cause="renderer reload
released the tile"`, and a card for a turn that no longer exists is never
re-offered.

### Every other surface a session raises

The same rule, applied to the channels that predate tiled chat groups. Each one
has to answer one question — is this news about ONE conversation, or about the
window? — and the answer decides where it is subscribed and who draws it.

**About one conversation, so per tile.** The token stream and the provider
fallback toast (`lvis:chat:stream`, `lvis:chat:fallback`) are labelled with
`chatGroupId` at the one main-side subscriber that owns those frames and
filtered in the preload adapter each tile holds, so an unaddressed frame can
only be a bug in one place. The filter is fail-closed: an unlabelled frame
reaches no surface at all. There is exactly one producer and it labels
everything it sends, so fanning an unlabelled frame out would answer a producer
bug by showing one conversation's tokens in every open tile. The skill badge (`lvis:skill-load:event`) is
window-wide on the wire and carries the session the tool ran in; the tile that
owns that session draws the badge, through the same `sessionOwnedBy` predicate
its cards use. An MCP app's `ui/message` and `ui/update-model-context` resolve
their card's own session across every live loop rather than comparing it to the
primary one. Away-authority arms the tile the renderer names and refuses a tile
the window is not showing rather than resolving it to the primary loop; the
session-todo channel refuses an unnamed session for the same reason.

**About the window, so subscribed once.** The approval-memory hit and the
permission-review suggestion report on the window's permission settings, not on
a conversation. They are subscribed once at App level and rendered once — per
tile they would raise the same toast in every open conversation at once.

**Overlay cards: owned, or the window's.** An `OverlayItem` carries the
conversation it came from when main knew one. A card with an origin renders in
the tile holding that conversation and its primary action continues THAT
conversation, resolved from the origin at click time rather than from the
surface that drew the card.

A card with no origin — a routine fire, a plugin event — and a card whose origin
conversation has left the screen are drawn once in the window's own band, above
the approval dock and inside the same height budget. This is stated, not fallen
back to, and it is literally the same home the window's approval dock gives an
unclaimed request. The alternative, drawing it in whichever tile
is focused, says the card belongs to that conversation when it does not, and
makes the card jump between tiles as focus moves. The window's region has no
conversation of its own, so its action names the focused one explicitly
(`actionChatGroupId`) — the same rule an unowned question already follows. An
orphaned card keeps its dismiss and loses its action: running it in a
conversation it was never staged for is the mismatch main refuses on the way in.

**The dock's activity line.** The floating dock holds ONE activity line while
the window can hold four conversations, so `DockActivity` names the conversation
and the dock draws that name above the summary. Required rather than optional:
an unlabelled line cannot be attributed, and the next line to arrive replaces it
without the user knowing what it replaced.

### The controls: split and drop

`useChatGroups` owns `split()`, `close()` and `dropOnEdge()`, bounded by
`MAX_CHAT_GROUPS` in work mode and 1 in chat mode; chat mode collapses to the
focused group. `split()` halves the **largest** tile along its longer side, not
the focused one — focus moves to whatever was just added, so a focus-based split
walks four clicks down to 124px columns, a quarter of the 448px floor a tile
inherits. Halving the largest turns the same four clicks into a 2x2.

Placement itself is the drop gesture above; the split control is the same thing
without a pointer to say which way.

## Why the control comes last

A split button that produced a tile with no loop behind it is worse than no
split button: it looks live and cannot answer. The control is therefore the
last thing to land, not the first.
