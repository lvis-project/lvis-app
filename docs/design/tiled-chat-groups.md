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
`get-history`, `get-write-diff`, `get-verbatim-tool-result`,
`get-sub-agent-transcript`, `enter-checkpoint-view`, `exit-checkpoint-view`,
`branch-from-checkpoint`, `main-active-state`, `has-provider`

**Window-scoped — unchanged:**
`sessions`, `session-history`, `session-update`, `session-delete`,
`export`, `import`

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
width DESIGN.md holds any surface to — and 240px down. The tree only knows
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
2. `src/ipc/domains/chat.ts` currently closes over ONE `conversationLoop` at
   registration (53 references) and builds one command port, one surface
   runtime, and one legacy adapter from it. Replace that with a memoized
   `chatGroupContext(chatGroupId)` returning the whole bundle, and have each
   per-conversation handler resolve its group from the payload.

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
