# Session Model v2

Status: Active implementation target
Last updated: 2026-05-16

This document is the source of truth for the session cleanup agreed on 2026-05-16.
It intentionally does not inherit previous automatic-history loading or routine
read-only designs. Fallback reads and migration support are out of scope.

## Goals

- Make session loading deterministic and user-controlled.
- Remove automatic loading of previous chronological sessions from the chat view.
- Keep explicit session navigation through history, search, calendar, and routine
  surfaces.
- Use one logical conversation-session model for main and routine conversations.
- Keep main and routine sessions isolated in lists and active-session restore.
- Preserve checkpoint/fork continuity through parent context, not through
  chronological previous-session loading.

## Non-goals

- No fallback to `~/.lvis/routine/sessions`.
- No migration of old routine JSONL result files.
- No automatic "latest today" or day-boundary session resume.
- No upward-scroll previous-session preview.
- No third read-only routine session model.
- No chronological "parent session" chain.

## Core Model

There is one conversation session model with an explicit kind:

```ts
type SessionKind = "main" | "routine";

interface SessionMetadata {
  sessionKind?: SessionKind;
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;

  parentSessionId?: string;
  branchedFromCompactNum?: number;
  branchedAt?: string;
  summaryPreamble?: string;
  checkpoints?: Checkpoint[];
  title?: string;
}
```

`main` and `routine` sessions share the same load, save, resume, compact,
checkpoint, fork, tool-history repair, and message-rendering behavior. A routine
session is not a separate session type. It is a normal conversation session with
routine metadata and default list isolation.

Rules:

- `sessionKind` is the only discriminator between main and routine sessions.
- Missing or invalid `sessionKind` is normalized to `"main"`.
- `routineId` without `sessionKind: "routine"` is still a main session; routine
  metadata never acts as a fallback discriminator.

UI state may expose a generic `currentSessionTitle` for the currently loaded
conversation. It must not expose a routine-specific current-title state. Routine
metadata can inform the stored session title, but the renderer should display it
through the same current-session title path used by main sessions.

## Storage Policy

All session state belongs under `~/.lvis/sessions`.

The implementation may choose the internal file layout, but it must expose one
logical session repository with `sessionKind` filtering. The default list and
restore paths must treat `main` as the default kind. Routine surfaces must query
`routine` sessions explicitly by `routineId`.

Required active-state file:

```txt
~/.lvis/sessions/.active-session.json
```

Required logical shape:

```json
{
  "mainActiveSessionId": "session-id-or-null",
  "mainActiveMode": "resume",
  "updatedAt": "2026-05-16T00:00:00.000Z"
}
```

The active-state file tracks only the main active session. Opening or continuing
a routine session must not overwrite `mainActiveSessionId`.

`mainActiveMode` is an enum: `"resume"` or `"fresh"`.

When the user explicitly starts a new main session, the active state must record
that fresh session intent immediately. If the app restarts before the user sends
a message, the app must return to a blank fresh main session rather than loading
an older session.

When `mainActiveMode` is `"fresh"`, `mainActiveSessionId` must be `null` or
ignored. Startup must not resume any session from that field while the mode is
fresh. After the user sends the first message in that explicit fresh main
session and the session is persisted, active state must switch to
`mainActiveMode: "resume"` with the new main session id.

## Main Session Startup

Startup restore must follow this order:

1. Read `~/.lvis/sessions/.active-session.json`.
2. If `mainActiveMode` is `fresh`, show a fresh blank main session.
3. If `mainActiveMode` is `resume` and `mainActiveSessionId` exists, resume that
   exact main session.
4. If the current in-memory conversation already has messages for that exact
   active main session, hydrate it instead of replaying from disk.
5. If active state is missing or invalid, show a fresh blank main session.

If the current in-memory conversation is a routine session during renderer
re-entry, startup must still restore the main active state. Routine in-memory
state never wins over `mainActiveSessionId`.

Startup must not inspect "today", KST date windows, noon boundaries, or the
latest modified session. Dates do not decide which session is loaded.

If the user worked alternately in two main sessions, app restart resumes the last
explicitly active main session recorded in active state. It does not infer from
mtime except as a display sort inside explicit session lists.

## Previous Session Loading

The chat transcript is the current session only.

Rules:

- Upward scroll does not load previous chronological sessions.
- The chat view does not render previous-session previews above the current
  conversation.
- Date windows are not used to find older sessions.
- Same-day, previous-day, KST, and noon boundaries are not chat-continuity rules.

Allowed explicit loading:

- User selects a session from history.
- User selects a search result.
- User selects a calendar/session marker.
- User opens a routine session from routine UI.
- User forks from a checkpoint.

Each explicit action must load the exact selected session. No implicit neighbor
session should be loaded around it.

## Parent Session Semantics

`parentSessionId` is fork/checkpoint provenance only.

It does not mean:

- previous chronological session,
- previous active session,
- latest session before current session,
- routine parent,
- day-boundary predecessor.

A parent relationship may be created when the user forks from a checkpoint. At
fork time, the child session must materialize the required continuity:

- the checkpoint summary,
- the relevant recent conversation portion,
- branch metadata such as `parentSessionId`, `branchedFromCompactNum`, and
  `branchedAt`.

Loading the child session must therefore be self-contained. The user may see that
the session was resumed from prior context, but the app must not auto-load the
parent transcript as another previous session.

If parent metadata exists but the parent file is unavailable, the child session
still loads. There is no fallback to chronological previous sessions.

## Routine Sessions

Routine sessions are normal conversation sessions with `sessionKind: "routine"`.

Required behavior:

- A routine fire creates or updates a routine conversation session through the
  same logical session repository used by main chat.
- The routine's first turn may run headlessly, but persistence must use the
  normal session model rather than a read-only result JSONL store.
- Opening a routine result loads the exact routine session into a conversation
  surface that can continue the dialogue.
- Routine overlay/cards that have a `routineSessionId` must load that exact
  session id directly. They must not re-query by `routineId + firedAt` and then
  guess from a list.
- Routine completion overlays may show a short summary/preview for immediate
  feedback. Restored pending overlays must derive that summary only from the
  exact stored `lastRoutineSessionId`, not from latest/firedAt fallback matching.
- Routine history list previews are kept as an explicit navigation surface. These
  are the short preview rows in the routine list/detail panel that let the user
  choose a past routine conversation.
- Routine conversation timelines follow the same rule as main chat: scrolling
  upward inside an opened routine conversation must not load or preview another
  routine session.
- Pending routine results restored after restart use the routine record's stored
  `lastRoutineSessionId`. If that exact session is unavailable, the result card
  does not attach a conversation instead of guessing from date, routine id, or
  latest modified session.
- If the user is in the middle of an active chat stream, opening a routine result
  must be blocked and the result must not be acknowledged as seen.
- The UI must clearly indicate that the active conversation is a routine session.
- Continuing a routine session must not change `mainActiveSessionId`.
- On app re-entry, the app restores the main active session, not the last opened
  routine session.
- Default main session lists, calendar views, and startup restore exclude routine
  sessions unless the caller explicitly asks for routine scope.
- Routine lists query `sessionKind: "routine"` and usually filter by `routineId`.

## Session Lists and Filters

All list APIs must be explicit about scope:

```ts
interface ListSessionsOptions {
  kind?: SessionKind;
  routineId?: string;
  limit?: number;
  before?: Date;
  beforeId?: string;
  after?: Date;
}
```

Defaults:

- Main history UI: `kind: "main"`.
- Startup restore: active-state lookup only, then exact main session resume.
- Routine panel: `kind: "routine"` and `routineId`.
- Global search: caller chooses `main`, `routine`, or `all`.

Routine sessions must never appear in main history because a filter was omitted.
Missing kind should default to `main`, not `all`.

## Edge Cases

- Two main sessions edited alternately: restore the last explicitly active main
  session from active state.
- User starts a new main session and quits before sending: restart to blank fresh
  main session.
- Background routine fires while user is in main chat: persist routine session,
  show routine notification/card if needed, do not alter main active state.
- User opens and continues a routine session: routine conversation continues, but
  app restart returns to main active state.
- User opens the routine history list: show routine session rows with short
  previews; clicking a row loads exactly that routine session.
- User scrolls inside a routine conversation: do not prepend previous routine
  sessions or any previous-session preview.
- User explicitly loads an older main session: set that as main active state.
- User explicitly loads an older routine session: do not set main active state.
- User forks from checkpoint: create a self-contained child with parent
  provenance and prior-context summary.
- Parent session deleted or corrupt: child remains loadable; no chronological
  fallback.
- Missing active-state file: start fresh blank main session.
- Corrupt active-state file: start fresh blank main session and replace state on
  next explicit main-session action.
- No API should infer continuity from mtime except for sorting explicit lists.

## Implementation Acceptance Criteria

- Upward scrolling in chat does not call session-list/history APIs to hydrate
  previous sessions.
- The previous-session preview UI is gone.
- Date-window startup helpers and related startup heuristics are removed.
- No noon, KST, or day-window split decides startup resume.
- `~/.lvis/sessions/.active-session.json` is read and written for main active
  state.
- Explicit new main session persists fresh intent across restart.
- Default session list/search/calendar behavior excludes routine sessions unless
  routine/all scope is requested.
- Routine sessions can be opened and continued as conversations.
- Routine result cards open the exact `routineSessionId`.
- Routine result cards and pending result replays preserve the short summary from
  the exact routine session preview.
- Routine history list rows preserve their preview text.
- Routine conversation scroll does not load previous routine sessions.
- Current-session title is exposed through a generic session field, not a
  routine-only field.
- Opening or continuing routine sessions does not mutate main active state.
- App startup after routine work restores the main active session.
- `parentSessionId` is only used as checkpoint/fork provenance.
- Forked sessions load summary/recent context without auto-loading parent
  transcript.
- `~/.lvis/routine/sessions` fallback reads are absent.

## Implementation State

These implementation areas were reconciled with this document:

- Startup restore uses active-state restore, not renderer date/session heuristics.
- Continuous-history hydration and previous-session marker rendering are removed
  from the chat view.
- Routine v2 persistence uses the unified session repository with
  `sessionKind: "routine"`.
- Routine result opening loads the exact `routineSessionId` into a continuable
  conversation surface.
- Routine history list previews and routine overlay summaries are preserved while
  timeline-level previous-session previews remain removed.
- Session metadata/list/search IPC contracts accept `sessionKind` scope and
  default omitted scope to `main`.
- Main active-session writes happen only for explicit main session actions.
- Stale code comments that referenced deleted session blueprints were updated or
  removed while preserving still-valid checkpoint/compact behavior.

## Test Expectations

- Startup resumes the exact active main session across date changes.
- Startup with `mainActiveMode: "fresh"` shows blank chat even when older sessions
  exist.
- Explicit session load updates main active state only for main sessions.
- Routine session load and continued turns preserve main active state.
- Default `listSessions()` returns only main sessions.
- Routine list returns only matching routine sessions.
- Routine list rows include preview text for explicit session selection.
- Upward scroll does not prepend historical sessions.
- Upward scroll inside an opened routine session also does not prepend historical
  routine sessions.
- Checkpoint fork stores parent provenance and self-contained summary context.
- Routine JSONL paths outside the unified session repository are not read.
