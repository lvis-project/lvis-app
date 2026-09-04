# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-27 (Asia/Seoul)
- Primary product surfaces: LVIS desktop renderer, chat workspace, work mode, plugin pages, settings, marketplace, right-side action/activity surfaces.
- Evidence reviewed:
  - External index: `https://github.com/voltagent/awesome-design-md`
  - VS Code workbench benchmark (2026-08-27): `code.visualstudio.com/api/references/theme-color`,
    `/docs/getstarted/userinterface`, `/api/ux-guidelines/{overview,sidebars,editor-actions,context-menus}`
  - Downloaded reference docs via `getdesign`: Linear, Raycast, Vercel, VoltAgent
  - Local token system: `src/styles.css`, `src/shared/theme-bundles.ts`, `src/ui/renderer/theme/`
  - Local component surfaces: `src/ui/renderer/components/ChatSidePanel.tsx` (the work panel, which holds tool activity), `Sidebar.tsx`, `InputActionBar.tsx`, plugin host pages
  - Local docs: `docs/development/theme-system.md`

## Brand
- Personality: calm, technical, high-agency, and work-focused.
- Product feel: an operator workbench, not a marketing page. The app should feel dense, clear, and stable under long-running agent work.
- Trust signals: visible state, accurate side-effect reporting, preserved position/context, restrained interaction feedback, and clear boundaries between navigation, work canvas, plugins, and settings.
- Avoid: decorative cards, nested boxes, one-note color palettes, gradient blobs, hero composition, oversized headings inside tool surfaces, and heavy shadows as the primary hierarchy tool.

## Product goals
- Give users a reliable desktop agent environment where chat, work mode, tools, plugins, settings, and local status can coexist without visual noise.
- Make side effects and system state legible: files read/written, plugin calls, MCP calls, model/mode, approvals, indexing, and permissions.
- Keep repeated workflows efficient: navigation must preserve context, controls must remain compact, and plugin pages must share one host-level layout grammar.
- Support localized UI as a first-class path, including Japanese and Chinese, without falling back to English for newly added product text.
- Make theme work predictable by routing colors, surfaces, focus, and motion through product tokens rather than component-local reinvention.

## Personas and jobs
- Primary personas: developers, AI-workflow operators, plugin builders, and reviewers using LVIS for iterative desktop work.
- User jobs:
  - Continue a task while understanding what the agent is doing.
  - Inspect plugin/system state without losing chat or scroll context.
  - Switch between chat and work modes without semantic ambiguity.
  - Configure model, provider, reasoning, approvals, language, and theme with minimal hunting.
  - Review recent side effects quickly during or after a run.

## Information architecture
- Primary navigation: left sidebar owns app-wide routes and plugin entry points.
- Primary canvas: route content owns the main work area. Page bodies should not be wrapped in extra decorative boxes when the page itself is already a surface.
- Top/page navigation: first-depth plugin or settings pages may expose a simple back control when leaving the current page should return to the previous route.
- Chat/work mode: mode controls are operational state, not navigation. Internal values and displayed labels must remain aligned.
- Secondary surfaces: action panels, popovers, command pickers, and inspectors float above the canvas only when they are temporary or auxiliary.

## Design principles
1. Product UI is the reference.
   - Use real app state and real product surfaces. Do not add abstract decoration to make a screen look designed.
2. Hierarchy comes from tokens and layout.
   - Prefer whitespace, hairlines, semantic surfaces, and restrained elevation. Avoid box-in-box layouts unless the inner box is a distinct repeated item, modal, or framed tool.
3. Accent color means work.
   - Reserve primary accent for active work, selected state, send/confirm actions, and important live state. Status colors remain literal: success, warning, destructive, info.
4. Motion acknowledges, it does not perform.
   - Motion should confirm state changes and help orientation. It should not distract from text, code, or tool output.
5. Token-first implementation.
   - New colors, shadows, focus rings, and motion values must enter through shared tokens when they represent reusable UI language.
6. Localization is a product requirement.
   - New user-facing strings must include generated catalog coverage and generated locale entries for supported languages.

## Visual language
- Color:
  - Components consume semantic tokens (`bg-card`, `text-foreground`, `border-border`, `text-primary`, etc.).
  - Theme bundles map semantic tokens to palettes. Components do not consume primitive palette values directly.
  - The new `executive-graphite` bundle is the reference restrained dark theme: warm graphite chrome, teal work accent, amber branch/caution accent, and limited secondary emphasis.
- Typography:
  - Use system UI text for renderer surfaces and monospace only for code, paths, commands, counters, and technical metadata.
  - Type scale (matches shipped de-facto usage — `text-xs` dominates dense surfaces):
    - `text-xs` (12px): default body inside dense panels, lists, metadata, and chrome.
    - `text-sm` (14px): comfortable body, control labels, dialog copy.
    - `text-base` (16px): lead paragraphs only; rare by design.
    - `text-lg` and above: page titles and section headers only — never inside repeated items.
  - No viewport-scaled type and no negative letter spacing in app UI.
  - Compact panels use compact headings; hero-scale type belongs only to real hero surfaces, which the app generally should not need.
- Spacing/layout rhythm:
  - Prefer dense 4/8/12/16px rhythm.
  - Toolbars and panels should have stable dimensions so counters, icons, hover states, and localized text do not resize the layout.
  - Page sections are full-width bands or unframed layouts with constrained inner content, not floating cards inside cards.
- Shape/radius/elevation:
  - Product cards stay at 8px radius or less unless an existing primitive requires otherwise.
  - Floating auxiliary surfaces may use 12px radius when they need clear separation.
  - Elevation uses `--surface-hairline`, `--elevation-raised`, and `--elevation-floating` rather than raw `shadow-xl`/`shadow-2xl`.
- Stacking (z-order ladder):
  - Canvas content stays at `z-0`–`z-30` (sticky headers/rails at `z-10`–`z-30`).
  - Docked auxiliary panels use `z-40`; all floating overlays (dialog, popover, command picker, tooltip, toast) share the `z-50` band and rely on portal/mount order within it.
  - Arbitrary escapes (`z-[9000]`-style) are drift, not a tier — fold the remaining outliers back into the ladder when touched.
- Motion:
  - Use `--motion-fast`, `--motion-base`, `--motion-slow`, `--motion-ease-out`, and `--motion-ease-standard`.
  - `prefers-reduced-motion` is authoritative.
- Imagery/iconography:
  - Use lucide icons for actions and categories when available.
  - Icon sizes (de-facto standard): 14px (`h-3.5 w-3.5`) is the default in dense chrome and buttons; 12px (`h-3 w-3`) inline beside captions/metadata; 16px (`h-4 w-4`) in comfortable rows and dialogs. Larger sizes are reserved for identity marks (plugin/app icons), not actions.
  - Avoid visible text where a familiar icon plus tooltip communicates the control more cleanly.
- Data display:
  - Numeric columns and counters use `tabular-nums` so digits align and layouts stay stable while values tick.
  - Truncation is intentional: single-line cells use `truncate`; multi-line summaries clamp at 1–2 lines (`line-clamp-1/2`). Paths and identifiers truncate with a tooltip carrying the full value; prefer keeping the tail (filename) visible.
  - Timestamps are compact and locale-aware; relative time may be used in activity feeds but absolute time must be recoverable (tooltip or detail).

## Workbench model

Benchmarked against the VS Code workbench (`code.visualstudio.com/api/references/theme-color`,
`/docs/getstarted/userinterface`, `/api/ux-guidelines/*`). VS Code is the closest shipping
product to what LVIS is: a dense, long-running operator surface where several pieces of work
are open at once and the chrome has to stay out of the way. What follows is what we take from
it and — just as important — what we do not.

### Parts own their tokens, and the part boundary is the design boundary

VS Code splits the window into named parts — Title Bar, Activity Bar, Side Bar, Editor Group,
Panel, Status Bar — and gives each its own token family (`titleBar.*`, `sideBar.*`,
`editorGroup.*`, `editorGroupHeader.*`, `breadcrumb.*`). A control's appearance is decided by
which part it is in, not by what it does. Ours are: **window band**, **sidebar**, **chat
group**, **work panel**, **status strip**.

The rule that follows is the one worth internalising: *an action belongs to the part that owns
the thing it acts on.* Pin, export, and import act on a conversation, so they belong to the
chat group, not to the window band. A control placed in the wrong part is a token violation
before it is a layout one.

### The work container is a framed group

VS Code's editor group is a **bordered container**, not an open canvas: `editorGroup.border`
separates groups, `editorGroupHeader.tabsBorder` is the hairline under the header, and
`editorGroup.focusedEmptyBorder` puts *focus on the frame itself*. That last token is the
tell — in a multi-group workbench, "which one am I typing into" has to be answerable at a
glance, and the frame is what answers it.

For LVIS this means the chat area is an outlined group with its own header, and the focused
group is distinguishable by its border. This is a deliberate, narrow exception to
"Avoid box-in-box layouts": the chat group qualifies as *a distinct repeated item* under
principle 2, and it earns the frame precisely because it repeats.

### Group header carries title on the leading edge, actions on the trailing edge

The header is the group's own strip: what this group holds, then what you can do to it. Actions
scoped to the whole container live here, and the same actions appear in the container's context
menu. The trailing edge ends with the group's own controls — its sidebar toggle, its split, its
close — so the frame is self-sufficient: everything you can do to a group is reachable from the
group. VS Code's sidebar guidance is explicit that a toolbar should stay small — *"be careful to
not add too many actions to reduce clutter and confusion"* — so the header takes the few actions
that act on the conversation and nothing else.

### The path names what is open, on a leading edge

Breadcrumbs in VS Code sit at the **top of the editor content, on the leading edge** — under the
chrome, above the text — because the path describes what is open, not where the window is. Their
tokens (`breadcrumb.foreground`, `breadcrumb.activeSelectionForeground`) are content tokens, not
title-bar tokens. What we take is the association and the edge; what we do not take is the
storey. Ours runs on the **leading edge of the window band**, starting exactly where the
sidebar card ends, because the band is the one strip that spans every pane and the path has to
name one location while several panes are open. A path floated to the *trailing* edge would
read as window furniture and lose the association — that is the placement the rule forbids, and
it is not this one.

What it names is the **focused pane's location**, since that is where the window is (see
`docs/design/tiled-chat-groups.md`). Moving focus between panes therefore moves the path, with
nothing navigated.

History navigation is the same subject seen from the other side: back and forward act on the
window's location, which is to say on the focused pane's content, so they stay in the chrome.

### Splitting is a first-class layout, not a window trick

Editor groups split vertically and horizontally, hold independent content, are rearranged by
drag, and are closed as a unit. Crucially each group is *complete on its own* — its own header,
its own actions, its own focus. A split that shares one header across panes is a split view, not
a group.

LVIS chat groups follow this: multiple chat groups tile in the main area, and each carries its
own header and its own sidebar. A group is the unit of both layout and state.

Two constraints we impose on ourselves that VS Code does not:

- **Flat list along one axis, not a split tree.** A tree buys arbitrary nesting, and nothing
  else in the app can address a nested position — not a keyboard command, not a restore, not a
  test. A flat list is the model the rest of the app can actually name a group in.
- **A group may only exist if a conversation source backs it.** Every source is a distinct
  conversation loop in the main process. When none is free, the split control is *absent*, not
  disabled. An empty tile that looks live is worse than no tile, and a chat box that cannot
  answer is not a layout feature.

### One frame for every pane, whatever it holds

The frame is the layout's origin, and there is one of it. A pane may hold a conversation,
a built-in view, Settings, or a plugin surface; the chrome around it does not change with
the content. The frame also owns the floating lane at the top-right of its body, so a card
floats over whatever the pane it is drawn in holds.
`src/ui/renderer/components/PaneFrame.tsx` is the only place that chrome is
drawn, and `src/ui/renderer/__tests__/PaneFrame.test.tsx` holds it there. A second frame
for a second kind of content is the defect this rule exists to name: two frames drift, and
the user learns two sets of controls for one idea.

What the frame owns, in order from the outside in:

- **Outline.** A 1px hairline on all four sides, `border-border` at rest. Focus is expressed
  on this border and nowhere else (see "The work container is a framed group"). Each cell
  pads by the tight chrome gap on every side, so two adjacent halves make the gutter between
  tiles; the frame's floors are measured on its content, and a split subtracts the cell
  inset (`PANE_CELL_INSET`) before comparing.
- **Header band.** One row, `--chrome-band-height` tall, the same height as every other
  chrome band. The leading edge starts with the same glyph the sidebar row uses
  for this content, then the title; a longer description lives on the title's hover and is
  never a second line. Then the content's own actions — what the caller passes, followed by
  what the body publishes through `usePaneActions` — drawn in the same row with the same
  control recipe. Then the split control. The trailing edge ends with the tile's own
  cluster: whatever this KIND of pane owns as a tile (a conversation's work-panel toggle,
  through `trailing`), maximize, close. Close is absent on the last tile, and a routed pane
  labels it with the view's own name because closing it returns the pane to its
  conversation rather than removing it.
- **Body.** Inset `none` for content that lays out its own edges — a conversation draws its
  transcript and composer to the hairline — or `page` for a built-in view that keeps the
  `PageShell` padding it had. The inset is a prop of the frame, not a wrapper the content
  adds, so a view moved into a pane inherits the margin instead of restating it.
- **Aside slot.** The work panel is the frame's guest: it stands as tall as the tile, beside
  the header rather than under it, and the conversation portals into the slot the frame
  publishes (`usePanePanelSlot`). The docked-or-floating verdict is measured against the
  frame, never against the content the panel itself resizes.

Floors are the frame's, not the content's, and there are two: `PANE_MIN_WIDTH` is the 448px
support floor every surface already holds (see "Responsive behavior"), and `PANE_MIN_HEIGHT`
is 280px — the measured height at which a tile still holds a header, a composer, and one
visible turn. A split that would put either half under a floor is not offered.

What differs between kinds is exactly three props — the leading glyph and title, the action
list, and the body inset — and nothing else. Everything a tile can have done to it (split,
close, maximize, receive a dropped conversation) is common to every kind because it acts on
the tile, not on what the tile shows. Settings is a pane like any other and takes the same
frame; its former page heading is the frame's header now. A plugin surface takes the frame
too, and the plugin draws only inside the body — the chrome is the host's, per "Plugin
surfaces".

### One frame for what must be settled before the next input

Some surfaces stop the conversation until the user answers: a tool approval, a question the
model put to the user, a deferred approval it is still waiting on. These share one frame and
one placement, because they share one meaning — *nothing further can happen in this
conversation until you decide*. The test for membership is that a turn is parked on the
answer. A surface that does not park a turn is not in this frame, however important it
looks.

The frame is the **card at the foot of the pane whose conversation asked**: flush with the
bottom edge, at the column's full width, in front of that pane's own content. When the pane
draws its conversation, that is the card over the composer; the composer goes `inert` while
the card is up, and the card takes the focus the composer would have had. When the pane is
routed to Settings, the work board or a plugin view, the same card is drawn in the same place
— the pane frame's `settle` slot — over the view, because the conversation behind the view is
still the one waiting. No backdrop, no dimming, no window-wide modal — the tile next door
keeps its caret and its running turn. The boundary the card may affect is the element marked
`data-approval-scope`, which is the PANE FRAME's column, and the invariant is that such a
scope contains at most ONE composer, the one this card is allowed to cover — a routed pane's
scope holds none, and the card covers nothing. `ApprovalDock`
(`src/ui/renderer/components/permissions/ApprovalDock.tsx`) and `QuestionOverlay`
(`src/ui/renderer/components/QuestionOverlay.tsx`) are the two cards; one drawing each, in
one slot, whether the pane shows its conversation or a view. The reviewer's suggestion is a
band inside the approval card rather than a toast of its own, and a deferred approval is put
to the user as a question through the same card, in the tile that deferred the call, rather
than as a chip of its own. `ApprovalDock.test.tsx` holds the scope contract.

A card belongs to the conversation that asked, and it is drawn ONLY by the surface that
holds that conversation: the pane holding it, or a side chat's own panel. It is never moved
to another pane, and the window draws none of them. When that surface is not on screen — a
pane the tree hides behind a maximized neighbour, a side chat whose panel is closed or whose
tab is not in front, a conversation no pane holds — the card stays parked in it, and the way
to it is marked with the **pending-answer dot**: one token (`--warning`), one size, one
label ("답변 대기 중"). The sidebar row of the interrupted conversation (a side chat's row and
its parent's both) carries it whenever a turn is parked, whether or not the card is on screen:
the row says "interrupted here". The maximize control of the pane covering a hidden one, the
work-panel toggle and the side-chat tab carry it only while the card is behind them. One
selector (`pendingAnswers` in `chat-group-session-registry.ts`) decides every dot, so the
sidebar and a pane header cannot disagree about who is waiting.

The one request with no conversation to belong to — a host or plugin ask that names no
session — is not in this frame: no turn is parked on it and no composer waits. It is an
answer-shaped card in the focused pane's floating right lane (`ApprovalLaneCard`), attributed
to the plugin or the host, following focus the way an unowned overlay card does, and the
Plugins row in the sidebar carries the dot while it waits. An unowned question is adopted by
the focused tile at arrival, because its answer needs a conversation to land in. The full
routing is in `docs/design/tiled-chat-groups.md`, "Cards belong to the conversation that
asked".

What is deliberately NOT in this frame, and where it goes instead:

- **A result or a proposal the user may leave for later** — a routine that fired, a plugin
  prompt staged for confirmation, a plugin's onboarding highlight — parks no turn. It is a
  card in the floating right lane of the focused pane (`FloatingRightLane`, rendered by the
  pane frame, one width for every occupant): it follows focus, and it is drawn whatever that
  pane shows — a conversation, Settings, a plugin view. A card raised by a conversation stays
  with the pane holding that conversation; while that pane is not drawn the card waits with
  it and the conversation's sidebar row carries the pending-answer dot. Its actions are
  answer-shaped (accept, later, never) and the host stores the answer; it never inerts a
  composer.
- **Status the app is reporting about itself** — a plugin update, bootstrap outcome, an app
  update, dev mode — is a pill in the window band's toolbar (`ToolbarStatusPill`), never a
  card. A pill's detail is its tooltip, so a busy pill stays hoverable and focusable.
- **An announcement from the marketplace** is external content: a dismissible banner in the
  top banner stack whose only action is navigation to a settings section. It moves the user;
  it changes nothing on their behalf.

The rule that sorts a new surface: if the turn cannot continue without the answer, it is the
card over the composer; if the user can act on it later, it is the lane or a pill; if it only
informs, it is a banner. A surface placed in the wrong tier is a frame violation the same way
a control in the wrong part is a token violation.

### Rows carry inline actions on hover and the same actions in a context menu

VS Code's list rows reveal inline actions on hover, and the row's context menu offers the same
set plus the rest. Two rules from the UX guidelines carry over verbatim: *group similar actions
together*, and *place large groups of actions into a submenu*. The inline affordance is the
frequent one; the menu is the complete one. They must not disagree about what is possible.

Hover treatment for an inline action is its own token family in VS Code
(`toolbar.hoverBackground` / `toolbar.activeBackground`), separate from the row's own
`list.hoverBackground` — a row highlight and a button highlight are different signals and must
not be drawn with the same value.

### What we do NOT take

- **The Activity Bar.** It exists because VS Code hosts many unrelated view containers. Our
  sidebar has one job; a second vertical rail would be chrome without content.
- **Tabs on the group.** VS Code tabs solve "many files, one group". Our chat groups are the
  tabs; adding a tab strip inside a group would nest the same idea twice.
- **The Status Bar as a dense readout.** VS Code packs it with per-language state we do not
  have. Our bottom strip stays minimal.
- **`workbench.*` naming.** Token names stay semantic (`bg-card`, `border-border`); VS Code's
  part-prefixed names are for a theming API we do not expose.

## Components
- Existing components to reuse: shadcn primitives in `src/components/ui/*`, theme provider, semantic token utilities, lucide icons, existing tooltip/popover/dialog primitives.
- Canonical app surfaces:
  - Sidebar: route ownership, conversation/project lists, and plugin entry points. Owns
    history navigation (back/forward) in its leading cluster strip; owns per-row inline
    actions and per-row context menus.
  - Chat group: the framed work container (see Workbench model). Owns its header — title on
    the leading edge, conversation-scoped actions and its work-panel toggle on the trailing
    edge — and owns its own work panel. Groups tile; each is complete on its own.
  - Main canvas: the tiled panes. A pane holds a conversation and draws whatever location it
    is on over it — its own conversation, a feature panel, Settings, or a plugin view — inside
    the same frame either way. The window's location is the FOCUSED pane's, and the window
    band carries it as the path on its leading edge.
  - Pre-input decision frame: the card at the foot of the pane whose turn is parked —
    approvals and questions, over the composer or over the view the pane is routed to —
    drawn only by the surface holding that conversation (see Workbench model, "One frame
    for what must be settled before the next input").
  - Pending-answer dot (`PendingAnswerDot`): the one mark for "a card is waiting for your
    answer" — `--warning` fill, a ring of the surface colour, one aria-label — on the
    sidebar row of every interrupted conversation, and on the maximize control, the
    work-panel toggle, the side-chat tab and the Plugins row while the card is behind them.
    One selector feeds every instance.
  - Command picker: search and 1st/2nd-depth command navigation.
  - Settings and plugin pages: dense product configuration surfaces using the same `PageShell` chrome.
  - SettingsSection: unframed settings/page bands for section grouping; do not wrap these bands in Card chrome.
- Variants and states:
  - Hover: subtle semantic surface tint, never layout shift. A ROW highlight and an inline
    BUTTON highlight inside that row are different signals and must not share one value.
  - Group focus: a framed container expresses focus on its own border, not only on the
    control inside it — with several groups open, the frame is what answers "which one
    am I typing into".
  - Active/selected: primary or route-specific accent with accessible foreground.
  - Focus: shared ring token, always visible for keyboard users.
  - Empty/loading/error/success: literal operational state, not decorative copy.
- Token/component ownership:
  - Shared primitives own focus, disabled state, base radius, and control structure.
  - Feature components own domain layout and data density.
  - Theme bundles own palette choices, not component behavior.

## Plugin surfaces (shared guide for plugin authors)
Plugin UIs are **free**: the SDK ships no UI components, tokens, or style checks. This section is the philosophy and the small set of hard boundaries that keep a free plugin UI feeling native inside the workbench.

### What crosses the webview boundary today
- Plugin panels render in isolated webviews. The shell injects **only the shared font stack** (`plugin-ui-shell.html`, mirroring `src/shared/host-font-stack.ts`). The app's semantic tokens (`bg-card` etc.), Tailwind setup, and theme bundles do **not** reach plugin webviews — bring your own styling.
- Host theme IS available, as an **opt-in event**: the host broadcasts the sticky `host.theme.changed` event carrying the `--lvis-*` token payload (replayed on subscribe — `src/plugin-preload.ts`; payload contract `src/shared/plugin-ui-tokens.ts`). A plugin may subscribe and apply those variables to follow the host theme, or ignore it and ship a self-contained palette that holds up on any host theme — both are legitimate. The SDK no longer ships the subscriber helper; vendor your own if you opt in.
- UI language is **not signaled** across the boundary (open design item — see Open questions). Keep your strings externalized so a locale signal can be adopted later.

### Chrome ownership
- The host draws the page chrome: sidebar entry, `PageShell` title/back control for plugin pages, and panel framing. **Do not draw a second page title bar or back button inside your panel** — your surface starts inside the content area.
- Inline, fullscreen, picture-in-picture, and side-panel presentation are host decisions; the same panel markup must work across them.

### Panel width is yours to spend
- The host hands the panel the **full width of the main pane** and does not cap it (`plugin-ui-host.tsx`, `maxWidth="none"`). Deciding how much of that a given piece of content should use is the plugin's job.
- Cap with `max-width`, never a fixed `width`. A fixed width makes the layout dead to the panel — the plugin renders identically at 928px and at 1960px, and widening the window changes nothing on screen. Stay fluid below the cap so the 448px floor still fills.
- Pick the cap from the content: prose (mail subjects, summaries) wants a reading measure; tabular content (folder lists, counts, matrices) wants the room.
- History: the host used to clamp every plugin panel to the chat reading column (~928px) because the plugin UIs were authored for a ~800px detached window and stretched at full width. That clamp treated the symptom and cost real width. It was removed once the plugins capped themselves; do not reintroduce it.

### Mandatory / recommended / free
| Level | Items |
|---|---|
| **Mandatory** | Works at the 448px panel floor (mobile-class base; verify at 448/640/1024). No horizontal page scroll. Keyboard-reachable essential actions with visible focus. WCAG AA text contrast. `prefers-reduced-motion` respected. No second page chrome. |
| **Recommended** | The philosophy in this document: operator-workbench feel, dense 4/8/12/16 rhythm, restrained accent (accent = work/selection, status colors literal), compact type scale, icons+tooltips over label noise, literal operational copy. |
| **Free** | Layout, component library, visual identity inside the panel, iconography style, brand accents — anything not listed above. A plugin may look like itself. |

## Token System Assessment
- Decision: keep the existing semantic token and bundle registry architecture. It is structurally sound and already supports multi-theme contrast tests.
- Required improvement: evolve the system beyond color. The previous gap was elevation and motion, which caused local shadow/timing choices to drift across panels and plugin surfaces.
- Implemented direction:
  - Add product-wide motion tokens in `src/styles.css`.
  - Add surface/elevation tokens and utilities in `src/styles.css`.
  - Add `executive-graphite` as a reference-quality restrained theme bundle.
  - Update `docs/development/theme-system.md` so future work follows the new token contract.
- Not needed now:
  - Replacing the theme bundle model.
  - Adding a new design-token package.
  - Moving every spacing utility to CSS variables before a repeated semantic need exists.
- Future migration target:
  - Replace remaining raw `shadow-xl`/`shadow-2xl` in floating panels with `lvis-surface-*` utilities.
  - Continue replacing route-local page chrome with `PageShell`/`SettingsSection` when new top-level surfaces are added.

## Accessibility
- Target standard: keyboard and screen-reader accessible desktop UI with WCAG AA contrast for text and meaningful controls.
- Keyboard/focus behavior: every visible command must be reachable by keyboard and expose a clear focus state.
- Contrast/readability: theme contrast tests are required for every shipped bundle.
- Screen-reader semantics: panels use landmarks/labels when they carry independent meaning.
- Reduced motion: all nonessential motion must collapse to near-zero duration under reduced-motion preference.
- Localization: UI must remain stable for Japanese, Chinese, Korean, English, Spanish, French, and German strings.

## Responsive behavior

### Support boundary
- LVIS is a **desktop-only** product: the sole runtime is a resizable desktop Electron window. There are no phone or tablet builds, no touch-first target, and no separate mobile app planned.
- Even so, every surface is designed **responsively across window widths**, using tablet/mobile-class width tiers as design boundaries. This is not aspirational: the enforced floors already put real surfaces inside phone-class widths — the main window clamps at **460px** (`MAIN_WINDOW_MIN_WIDTH`, `src/main/main-window-bounds.ts`) and a plugin side panel renders at **448px** (`SIDE_PANEL_MIN_WIDTH`, `src/shared/side-panel.ts`). A surface that only works at laptop width is a defect, not a nice-to-have gap.

### Width tiers (the shared breakpoint system)
Tiers map 1:1 onto the Tailwind default scale already used across the renderer (`sm:`/`md:`/`lg:` — no custom overrides), so the design language and the implementation utilities never diverge:

| Tier | Window/pane width | Tailwind | What must hold |
|---|---|---|---|
| **Mobile-class** | `< 640px` (floor: 448/460px) | base (mobile-first) | The **mandatory baseline**. Single-column layout; primary navigation compacts; every essential action reachable; no horizontal scroll of the page body; floating panels clamp to the viewport. Plugin panels live here whenever docked as a side panel. |
| **Tablet-class** | `640–1023px` | `sm:` / `md:` | Two-pane layouts may appear (list + detail, chat + rail). Density increases; controls may gain labels that were icon-only at mobile-class. Typical for half-screen window snapping and narrow laptops. |
| **Desktop-class** | `≥ 1024px` | `lg:` | Full workbench: sidebar + canvas + right-side action/activity surfaces concurrently. Multi-column settings and wide tables are allowed only here. |

- **Author mobile-first**: style for the mobile-class base, then enhance upward with `sm:`/`md:`/`lg:`. Never author a desktop-only layout and patch it downward.
- Tier checks are on **container/window width**, not device detection — a desktop window dragged narrow IS the mobile-class experience.
- Plugin authors: treat **448px** as your panel's hard floor and design the panel's base layout for mobile-class; a plugin page promoted to the main canvas may assume tablet-class and up. Verify at 448px, 640px, and 1024px before shipping.

### Layout adaptations
- Primary navigation may compact, but it must not duplicate route ownership.
- Floating panels must clamp to viewport width and height.
- Text inside controls must wrap or truncate intentionally without overlapping adjacent controls.
- Wide content (tables, code, diagrams) scrolls inside its own container — the page body never scrolls horizontally.

### Touch/hover
- Hover is enhancement only; all essential actions remain click/keyboard accessible. Touch input is tolerated (hover-independent affordances), never a design target.

## Interaction states
- Loading: use compact progress or status text near the affected control.
- Empty: state what is empty, not how the feature works.
- Error: use destructive semantics and include the next actionable recovery when available.
- Success: use success semantics sparingly; avoid celebratory motion.
- Disabled: preserve legibility and explain disabled controls through tooltip or adjacent status only when the reason is not obvious.
- Offline/slow network: keep local app navigation responsive and isolate remote failure to the affected operation.
- Notification hierarchy (pick the narrowest surface that fits):
  - **Inline status** next to the affected control — the default for operation results.
  - **Toast** for transient confirmations of a user-initiated action (e.g. saved); auto-dismissing, never load-bearing.
  - **Banner** for persistent, page-scoped conditions that need action (e.g. update available); dismissible, stays until resolved.
  - **OS notification** only for events the user must see while the window is unfocused; always mirrored by in-app state.

## Content voice
- Tone: concise, operational, literal.
- Terminology:
  - Use "Work" for the former action mode, including internal values.
  - Use "Chat" for conversation-only mode.
  - Use "provider", "model", "reasoning", "approval", "plugin", "MCP", and "local indexer" consistently.
- Microcopy rules:
  - Do not add tutorial text inside normal app surfaces.
  - Labels identify the data or action.
  - Tooltips can explain icon-only controls or unavailable actions.

## Implementation constraints
- Framework/styling system: React, TypeScript, Tailwind v4 utilities, CSS variables in `src/styles.css`, existing shadcn primitives.
- Design-token constraints:
  - No component-local palette values for reusable UI language.
  - No raw heavy shadow utilities for new floating surfaces when `lvis-surface-*` applies.
  - No new dependency for design tokens without a concrete migration need.
- Performance constraints:
  - Theme switching must remain runtime CSS-variable based.
  - Repeated panels should cap rendered detail lists and avoid layout reflow from dynamic counters.
- Compatibility constraints:
  - Keep Electron renderer build, theme bundle tests, contrast tests, and i18n parity tests passing.
- Test/screenshot expectations:
  - Theme changes require bundle invariant tests and contrast coverage.
  - Layout changes require targeted component/e2e smoke or visual inspection when practical.

## Open questions
- Should typography scale tokens be promoted once Japanese/Chinese visual QA identifies repeated density adjustments?
- Plugin webview theme signal, long-term shape: the sticky `host.theme.changed` event already carries the full `--lvis-*` token payload (opt-in, see Plugin surfaces). Open: is that full token payload the stable long-term contract, or should it narrow to a minimal light/dark + semantic-variable signal now that the SDK no longer ships token helpers? Design pending.
- Plugin locale signal (i18n wiring): plugins should be able to FOLLOW the host UI language (strings externalized; no language is mandated), but no locale getter/change signal crosses the runtime or webview boundary yet. Wiring design pending; reviewed 2026-07-10.
