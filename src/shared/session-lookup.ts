/**
 * session-lookup.ts — ONE authority for "resolve a partial session id".
 *
 * `/load <partial-session-id>` is implemented twice: the renderer intercepts
 * typed composer input (`src/ui/renderer/hooks/use-send-message.ts`) and the
 * engine dispatcher owns the CLI / local-api entry points
 * (`src/engine/turn/commands.ts`). They answered differently on the same input:
 * the engine searched every persisted session of every kind, while the renderer
 * inherited the `lvis:chat:sessions` defaults (20 rows, `kind: "main"`) because
 * it passed no options at all — so `/load abc123` resolved from the CLI and
 * reported "session not found" in the composer for anything older than the 20
 * most recent main sessions, or for any routine-kind session.
 *
 * The engine side is the authority: `/load` takes an id the user already has,
 * so the lookup is scoped by the id itself, not by recency or kind. This module
 * holds the match predicate and the widest query the IPC will honour, and both
 * callers read them from here.
 *
 * `SESSION_LIST_MAX_LIMIT` is also the clamp the `lvis:chat:sessions` handler
 * applies (`src/ipc/handlers/chat.ts`), imported from here so the renderer can
 * never ask for a page size the handler silently trims.
 *
 * The `lvis:chat:sessions` REQUEST contract grew a reply contract for the same
 * reason: {@link SessionFamily} and {@link SessionListRow} describe one row of
 * the conversation list, and main, the preload bridge and the renderer each
 * used to spell them out again. `shared/` is the neutral zone all three can
 * import from without forming a cross-boundary dependency.
 */

/**
 * Largest page `lvis:chat:sessions` will return. The handler clamps to this,
 * so asking for more is indistinguishable from asking for exactly this.
 */
export const SESSION_LIST_MAX_LIMIT = 100;

/**
 * How a session was started: a user's chat, a routine's run, or a sub-agent
 * child. Persisted in every session's metadata, so it is on the wire and in
 * the renderer as well as in the store — one spelling for all three.
 */
export type SessionKind = "main" | "routine" | "subagent";

/**
 * The conversation family one list row belongs to — what glyph it draws, what
 * its click opens, and whether it offers the main store's row actions.
 *
 * `main` and `routine` are the two kinds the main store holds; `work-board` is
 * an item's run and `side-chat` a rail conversation, each in its own store.
 */
export type SessionFamily = "main" | "routine" | "work-board" | "side-chat";

/**
 * Every family, as a table keyed by the union so the compiler — not a reviewer
 * — checks that the runtime value set is complete. A `Set<SessionFamily>` built
 * from an array accepts a short array: adding a member to the union then leaves
 * the request validator silently dropping it, which is exactly how the sidebar
 * would lose a family nobody noticed was missing.
 */
const SESSION_FAMILY_TABLE: Readonly<Record<SessionFamily, true>> = Object.freeze({
  "main": true,
  "routine": true,
  "work-board": true,
  "side-chat": true,
});

/** Every family, in the order a caller that wants all of them should ask. */
export const SESSION_FAMILIES: readonly SessionFamily[] = Object.freeze(
  Object.keys(SESSION_FAMILY_TABLE) as SessionFamily[],
);

/**
 * Whether a value crossing the preload boundary names a family this host has.
 * Renderer-supplied arrays are untrusted input, so callers narrow with this
 * rather than casting.
 */
export function isSessionFamily(value: unknown): value is SessionFamily {
  return typeof value === "string" && Object.hasOwn(SESSION_FAMILY_TABLE, value);
}

/**
 * One row of the conversation list, whatever store it came from.
 *
 * `family` is the discriminant every consumer switches on: the sidebar picks a
 * glyph, a label and a click path from it, and never re-derives any of that
 * from an id. Main stamps it once, at row assembly.
 *
 * `originSessionId` is the conversation a row was started from — the side
 * chat's parent. It is deliberately NOT the checkpoint/fork provenance that
 * `SessionListEntry.parentSessionId` records: those are two different
 * relations, and spelling them with one name is how a fork ended up looking
 * like a side chat's parent to anything reading the wire.
 */
export interface SessionListRow {
  id: string;
  modifiedAt: string;
  title: string;
  sessionKind: SessionKind;
  family: SessionFamily;
  /** Present on a work-board run row — the item it opens. */
  workBoardItemId?: number;
  /**
   * Present on a side-chat row — the conversation it belongs to, so the
   * sidebar can draw it under that conversation instead of beside it.
   */
  originSessionId?: string;
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;
  projectRoot?: string;
  projectName?: string;
  /** Compact sequence number this session was forked from. Only on true forks. */
  branchedFromCompactNum?: number;
  /** ISO timestamp when this session was branched. Only on true forks. */
  branchedAt?: string;
  /** ISO time the user archived this conversation. Absent = not archived. */
  archivedAt?: string;
  /** ISO time the user marked it unread. Absent = read. */
  unreadSince?: string;
}

/**
 * A routine's run rows: the same conversation row the sidebar draws, plus the
 * opening snippet the routine panel shows under it. The panel and the sidebar
 * list the same sessions, so they read the same row — the snippet is the one
 * field only the panel has room for.
 */
export interface RoutineRunRow extends SessionListRow {
  preview: string;
}

/**
 * The query `/load` must use when resolving a partial id through the
 * `lvis:chat:sessions` IPC: every kind, widest page the handler allows.
 *
 * KNOWN RESIDUAL: the IPC is paginated and hard-capped, so a renderer-side
 * `/load` still sees at most `SESSION_LIST_MAX_LIMIT` sessions where the engine
 * dispatcher sees all of them. That is a bounded, explicit gap; the previous
 * implicit gap was 20 rows of one kind.
 */
export const SESSION_ID_PREFIX_LOOKUP_QUERY = Object.freeze({
  kind: "all",
  limit: SESSION_LIST_MAX_LIMIT,
} as const);

/**
 * Resolve a partial session id to the first listed session whose id starts with
 * it. An empty prefix never matches — callers surface their own usage error for
 * a bare `/load`, and an empty prefix would otherwise select an arbitrary
 * session.
 */
export function findSessionByIdPrefix<T extends { id: string }>(
  sessions: readonly T[],
  prefix: string,
): T | undefined {
  const requested = prefix.trim();
  if (requested.length === 0) return undefined;
  return sessions.find((session) => session.id.startsWith(requested));
}

/**
 * How much of a session id a surface shows when the full id would not fit —
 * a list row, a badge, an aria label. Also the prefix `/load` resolves, so
 * what the user reads off a row is what they can type back. Seven surfaces
 * sliced eight characters and one sliced twelve; this is the one number.
 */
const SESSION_ID_DISPLAY_LENGTH = 8;

export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH);
}
