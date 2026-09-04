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

## Pane content: a conversation, and whatever is drawn over it

A tile is a **pane**, and a pane holds two things that are not the same thing.

Underneath is its **conversation** — the loop, the transcript, the composer
draft, the scroll position. That is what makes the pane a pane: every pane is
created by a gesture that means "put a conversation here" (a split, an edge
drop, the sidebar's new-pane gesture), and `conversationIds` is the set that
records it.

On top is its **location** — a `ViewLocation`, the same union the window's
location has always used, held per pane in `contentById`. `{view:"home"}` means
"draw this pane's own conversation"; every other value is a feature panel,
Settings or a plugin view drawn over it. The conversation is not taken away
while a view covers it: the tile stays mounted and goes `hidden`, as it does
when another tile has the box — with one difference the cards care about. A
routed pane still has a frame on screen, so the cards its conversation is
parked on are drawn in that frame; a pane the tree is not drawing has none,
and its cards wait with it (`paneHidden`).

The location lives beside the tree, not inside it, for the same reason
`panelOpenIds` does: the tree is geometry, and a leaf that carried content would
make every split, close and resize rewrite something it has no opinion about.

### The window is the focused pane

`activeView` is not a second piece of state. It is
`contentById[focusedId].view` — so the top band's path, the sidebar's current
row and the persisted `system.activeView` key all name the FOCUSED pane's
location, and moving focus between panes moves the window without any pane's
content changing. The path follows a focus change for that reason, not as a
special case.

### Three rules

1. **Choosing a view replaces the focused pane's content.** The conversation
   stays underneath, so closing the view puts the pane back on it.
2. **A non-home location may be open in ONE pane at a time.** Choosing one that
   another pane already shows focuses THAT pane instead of drawing a second
   copy — `paneShowing` is where the rule is evaluated, and it is asked by both
   readers of it. Two Settings panes would fight over the single persisted
   `system.settingsTab`; two views of one plugin are two `<webview>` guests in
   one partition, sharing storage while disagreeing about the plugin's state.
   Home is exempt: a pane's home is its OWN conversation, not a shared place.
3. **Back and forward move the focused pane**, and where the recorded location
   is already open in another pane they move FOCUS to that pane — rule 2 again,
   not a second rule for history.

### Opening in a new pane

The sidebar's rows offer a second destination: a new pane beside the focused
one, reached by a meta/ctrl click and named in the row's own context menu. The
menu is what makes it a gesture rather than a secret.

It makes the same pane the header's split makes, and asks the split's own two
questions — both ceilings (`MAX_PANES` leaves, `MAX_CHAT_GROUPS` loops) and
`splitFits`, which refuses a halving that would put either side under the tile
floor. A refusal is SAID, because nothing in a menu row shows the limit the way
a missing split control does. In chat mode, which draws one pane and hides the
rest, the gesture is not offered at all — the same withdrawal `canSplit` makes
in the pane header.

The pane and the view it is opened with land in ONE commit. Two commits would
put the new pane's blank conversation between them, and visit history — which
records the location it observes — would keep that as a step the user never
took.

### Not persisted

The tree is not persisted, and neither is the content map (`useState`, and a
reload starts the pane counter over). What IS persisted is the focused pane's
location, under the keys it has always used — so a restart opens one pane where
the user left off, exactly as it did before panes had locations of their own.

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

The conversation's tool activity lives in the card, not in the header. When
the card has no tab open, its launcher shows the compact report — the six
counters and the newest few items by category — so an empty panel still
reports on the conversation, and its items open the very tabs the picker
offers. The full lists are spread over the tabs each one belongs to: the
files the session created, modified, deleted or moved are the file tab's
changed-files segment, each row wearing its change; the sites it visited are
the browser tab's list over its viewer; the sub-agents it opened are the
sub-agent tab; and every plugin and tool it called is the activity tab, which
the compact report links to. Each list reads latest first and scrolls inside
the card rather than stopping at a fixed count.

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
between. `PaneGutter.key` is that position written as a string — it is
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

The surface that holds the conversation is the ONLY surface that draws its
cards, and it draws them whether or not the user is looking at it. There is no
second copy and no fallback surface: a card never moves to another pane, and
the window draws no card of a conversation's. What changes with where the user
is looking is the FRAME the pane draws the card in, and whether a dot marks the
way to it:

- **The pane shows its conversation.** The card sits over the composer, which
  goes `inert` (`ApprovalDock`, `QuestionOverlay` in the composer dock).
- **The pane is routed** to Settings, the work board or a plugin view. The
  conversation is hidden, not the pane: the tile builds the same two cards and
  hands them to the routed frame's `settle` slot (`PaneFrame`'s `settle`,
  rendered at the foot of the frame body, full width — the same place the
  composer dock would be). The `data-approval-scope` is the pane frame's
  column, so the dock finds no composer in it and inerts nothing. The card is
  attributed to "이 패널의 대화 <title>" so the user knows what is waiting under
  the view.
- **The pane is not drawn** — the tree hides it behind a maximized neighbour
  (`paneHidden`). The tile keeps its claim and its cards and draws nothing:
  there is no frame to draw into. The pending-answer dot goes on the
  maximize control of the pane that covers it and on the conversation's
  sidebar row.
- **A side chat.** Its panel claims its loop's session for as long as the loop
  has one and draws its approvals and, through `useWorkflowTools`, its
  questions over its own composer. The side chat's view stays mounted behind
  another tab (`ChatSidePanel` hides it rather than unmounting it), so the
  claim and the cards live on; while the panel is closed or the tab is not in
  front the dot goes on the pane's work-panel toggle, on the side-chat tab, and
  on the side chat's sidebar row and its parent's. A tile never adopts a side
  chat's session (`tileDrawsSession`).
- **A conversation no pane holds** — a routine's, a work-board run's, a main
  conversation this window closed with its ask still parked. Nothing draws the
  card; the conversation's sidebar row carries the dot and the card appears
  when the row is opened. The host's `lvis:approval:settled` announcement
  keeps the queue honest meanwhile (below).

A `data-approval-scope` contains at most ONE composer, the one its dock may
cover; that invariant is what lets the routed frame and the side chat reuse
the same dock without covering a composer that is not theirs.

**The one request with no conversation** — a host or plugin ask whose
`sessionId` is undefined, or names a session no surface holds and no row
lists — is not parked on any turn, so no composer waits and no dock is right.
It is drawn as an answer-shaped card in the FOCUSED pane's floating right lane
(`ApprovalLaneCard`), attributed "플러그인 요청 · <plugin>" or "호스트 요청"
from the request's own `sourcePluginId`, following focus the way an unowned
overlay card does; it inerts nothing, and the sidebar's Plugins row carries the
dot while it waits.

**The dot.** One meaning, one drawing: `PendingAnswerDot`, a `--warning` fill
with a ring of the surface colour, labelled "답변 대기 중". It says "a card you
must answer is waiting where you are not looking", and nothing else — never
for a card the user can already see. Every place it appears is decided by ONE
selector, `pendingAnswers` in `chat-group-session-registry.ts`, from the
window's approval queue, every tile's questions and side chat, the reviewer's
deferred entries and the overlay queue: the sidebar rows, the maximize
control, the work-panel toggle and side-chat tab, and the Plugins row all read
that one answer, so two of them cannot disagree. A sub-agent's ask maps to the
row of the tile that spawned it; a side chat's, to its own row and its
parent's.

Overlay cards are the same rule read from the pane's side: the floating right
lane is the PANE FRAME's, so a card is drawn in a pane whatever that pane shows
— its conversation, Settings, the work board, a plugin view. A card no
conversation owns is drawn in the focused pane and follows focus. See "Overlay
cards: owned, or the window's" below.

`PANE_MIN_HEIGHT` is the measured floor, not a round number: it is the
frame height at which a tile still holds a header, a composer, AND one visible
turn. Shrinking the window with one tile up, the turn goes first — at a 290px
frame the transcript viewport is 11px, at 270px it is 0 and the composer starts
overflowing its column. 280px is where all three still fit. The floor lives on
what the tile contains, so it moves when the composer does rather than when the
window does.

A headless or routine turn is **not** a source of cards here. It has no
interactive approver by construction: the reviewer's headless lane answers
`low → allow` and anything above it `deny` (`PermissionManager.resolveReviewerDecision`),
so it never parks a request for a human. What actually reaches the lane is
therefore host and plugin asks that name no conversation; what reaches a
sidebar dot with no pane behind it is a card whose conversation left the
screen while the ask was parked.

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
approval goes to the focused pane's lane: its answer needs none. An unowned
overlay card takes the second road too — see below.

The card names the conversation by the surface's own label — the tile's title,
"Side chat", "이 패널의 대화 <title>" under a routed view, "Conversation not
open in any tile" — and keeps the raw session id in the review details, where
an identifier is useful.

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
session-tasks channel refuses an unnamed session for the same reason.

**About the window, so subscribed once.** The approval-memory hit and the
permission-review suggestion report on the window's permission settings, not on
a conversation. They are subscribed once at App level and rendered once — per
tile they would raise the same toast in every open conversation at once.

**Overlay cards: owned, or the window's.** An `OverlayItem` carries the
conversation it came from when main knew one. A card with an origin renders in
the tile holding that conversation and its primary action continues THAT
conversation, resolved from the origin at click time rather than from the
surface that drew the card. A card with no origin — a routine fire, a plugin
event — is drawn in the FOCUSED pane and follows focus: the window holds one
queue of such cards, and that queue has one reader, the user, who is at the
focused pane. A card parked in an unfocused pane is a card nobody is looking
at, and with several panes open it would soon be one card per pane. The
focused pane's region acts in its own pane (`actionChatGroupId`), so confirming
the card starts the turn where the user is.

The lane a card floats in is the PANE FRAME's, not the conversation's
(`PaneFrame`'s `lane`, rendered as `FloatingRightLane` at the top-right of the
frame body). A card is therefore drawn in its pane whatever the pane shows —
its conversation, Settings, the work board, a plugin view. The routing asks
whether the pane is DRAWN (`paneHidden`, the tree's answer), not whether its
conversation is visible (`hidden`, the tree's or the route's): a routed pane
draws its lane, and its approval and question cards go into the same frame's
`settle` slot, so nothing a routed pane holds leaves it.

A card whose origin conversation is not drawn — its pane hidden by the tree,
or no pane holding it — is drawn nowhere (`overlayCardTile` answers `null`).
It is that conversation's card: running it in whatever pane is focused is the
mismatch main refuses on the way in, and drawing it without its action was a
card that could only be dismissed. It waits in the queue instead, and the
conversation's sidebar row (and, for a hidden pane, the maximize control)
carries the pending-answer dot; opening the row draws the card with its
action, in the pane that then holds the conversation.

**The dock's activity line.** The floating dock holds ONE activity line while
the window can hold four conversations, so `DockActivity` names the conversation
and the dock draws that name above the summary. Required rather than optional:
an unlabelled line cannot be attributed, and the next line to arrive replaces it
without the user knowing what it replaced.

### The controls: split and drop

`useChatGroups` owns `split()`, `close()`, `dropOnEdge()` and `adopt()`, all
bounded by `MAX_CHAT_GROUPS` — the ceiling counts LOOPS, so it is the same in
both modes. What chat mode holds to one is the number of tiles it DRAWS: it
collapses to the focused group and keeps the others. The split and drop controls
are gated on `canSplit`, which does carry the mode, because they are gestures on
the CANVAS; `adopt()` is not, because giving an incoming conversation a group of
its own is not a canvas gesture. In chat mode the adopted group simply becomes
the one drawn, and the conversation it displaced keeps streaming behind it.

That is what the sidebar takes when the focused group is mid-turn. It has to
take something: a running turn writes through the loop that owns it, and
`saveSession` rewrites the whole session file from that loop's in-memory
history, so swapping the session under a running loop would write one
conversation's messages into another's file. Main refuses it, and the renderer
does not ask — it adopts instead. At the ceiling one group is set aside to make
room; its conversation is on disk, so reopening it is a resume, and the window
says so, because the click that caused it looked like plain navigation. The
spare is idle, is not the focused group, is not the one being adopted beside,
and is never the primary: releasing the primary also points its loop at a fresh
conversation and clears the persisted window-active session, so the next launch
would open blank instead of where the user left off. A group whose tile has not
published counts as busy — an unanswerable question is not an idle one.

**Mounted is not drawn.** A tile mounts for every leaf of the live tree; the
view decides only which of them gets a box. A leaf with no box is hidden with
`display:none` rather than unmounted, because unmounting takes down the stream
subscription, the streaming flag and the stop control of a turn that is still
running — the very turn the user stepped away from. Ownership and drawing are
therefore separate questions, and `TileSession.hidden` is how the window asks
the second one. A hidden tile still HOLDS its conversation (`tileHoldingSession`
counts it, so the sidebar still reports it as responding and its turn ending is
still bookkept) and DRAWS nothing: it releases its approval claim, draws none of
its own approval cards, and is filtered out of `overlayCardTile` and
`tileDrawsSession`. A card handed to a hidden tile is a card nobody can answer,
and an approval dock inside one steals keyboard focus, which drags the view back
to the conversation the user just left. Focus reveals for the same reason: in
work mode `maximizedId`, not focus, decides what is drawn, so focusing a tile a
maximize is hiding would move every focus-derived surface onto a tile nobody can
see.

`split()` halves the **largest** tile along its longer side, not
the focused one — focus moves to whatever was just added, so a focus-based split
walks four clicks down to 124px columns, a quarter of the 448px floor a tile
inherits. Halving the largest turns the same four clicks into a 2x2.

Placement itself is the drop gesture above; the split control is the same thing
without a pointer to say which way.

## Why the control comes last

A split button that produced a tile with no loop behind it is worse than no
split button: it looks live and cannot answer. The control is therefore the
last thing to land, not the first.
