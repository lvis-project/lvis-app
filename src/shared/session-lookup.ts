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
 */

/**
 * Largest page `lvis:chat:sessions` will return. The handler clamps to this,
 * so asking for more is indistinguishable from asking for exactly this.
 */
export const SESSION_LIST_MAX_LIMIT = 100;

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
