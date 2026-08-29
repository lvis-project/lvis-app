/**
 * The `board.json` file: its on-disk shape, its schema version, and the
 * read-time projection applied to every item loaded from it.
 *
 * Pure and side-effect-free — the CRUD implementation that reads and writes
 * the file lives in `src/main/work-board-store.ts`. Keeping the shape and the
 * projection rule here (rather than re-deriving them per consumer) means
 * `status_resolved` has exactly one definition.
 *
 * `status_resolved` (the `overdue` projection) is computed on every read so
 * consumers never re-derive it: an item is `overdue` when its stored status is
 * `planned` or `in_progress` AND its `due_at` is strictly in the past. It is a
 * read-time projection only — `overdue` is never persisted.
 */
import type {
  WorkItem,
  WorkItemStatusResolved,
} from "../shared/work-board-types.js";
import { localDayStart } from "../shared/local-date.js";

/** On-disk shape of `board.json`. */
export interface BoardFile {
  version: number;
  nextId: number;
  items: WorkItem[];
}

/** Current `board.json` schema version. */
export const BOARD_VERSION = 1;

/**
 * Compute the resolved status for a single item against a reference instant.
 * `overdue` applies only to not-yet-completed items with a past `due_at`.
 */
export function resolveWorkItemStatus(
  item: WorkItem,
  nowMs: number,
): WorkItemStatusResolved {
  if (
    (item.status === "planned" || item.status === "in_progress") &&
    item.due_at !== undefined &&
    Date.parse(item.due_at) < nowMs
  ) {
    return "overdue";
  }
  return item.status;
}

/** `Z` or `±HH:MM` at the end of an ISO instant, in minutes. `null` if absent. */
function explicitOffsetMinutes(iso: string): number | null {
  const match = /(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(iso);
  if (!match) return null;
  if (match[1]) return 0;
  const magnitude = Number(match[3]) * 60 + Number(match[4]);
  return match[2] === "-" ? -magnitude : magnitude;
}

/**
 * Re-anchor a due date that was stamped as midnight in some other zone.
 *
 * Until the board moved to the host calendar, the panel wrote a picked day as
 * `${day}T00:00:00+09:00` — midnight in Seoul. That is an absolute instant, so
 * its meaning did not change, but the day it now DISPLAYS under is the host's
 * day for that instant: on any host west of Seoul, an item the user set for the
 * 16th reads as the 15th. The user picked a day, not a moment, so the day is
 * what has to survive.
 *
 * Only a value that is unambiguously "midnight somewhere else" is touched:
 *
 *   - it must carry an explicit offset (no offset means we cannot tell what the
 *     writer meant, so we leave it alone);
 *   - that offset must differ from the host's offset at that instant (otherwise
 *     it is already host-local midnight, or a value we have already converted);
 *   - and its time of day IN ITS OWN OFFSET must be exactly 00:00:00.000.
 *
 * A due date with a real time on it was never a day-picker value and keeps its
 * instant exactly.
 *
 * Idempotent: the value it writes back is host-local midnight serialized as
 * UTC, so on the next load either the offset matches the host (nothing to do)
 * or the time of day is no longer 00:00 (nothing to do).
 */
export function normalizeDueAt(dueAt: string): string {
  const offsetMinutes = explicitOffsetMinutes(dueAt);
  if (offsetMinutes === null) return dueAt;

  const instant = new Date(dueAt);
  if (Number.isNaN(instant.getTime())) return dueAt;

  if (offsetMinutes === -instant.getTimezoneOffset()) return dueAt;

  // Read the wall clock the writer saw, by shifting into their offset and using
  // the UTC getters as a plain calendar reader.
  const asWritten = new Date(instant.getTime() + offsetMinutes * 60_000);
  const isMidnightThere =
    asWritten.getUTCHours() === 0
    && asWritten.getUTCMinutes() === 0
    && asWritten.getUTCSeconds() === 0
    && asWritten.getUTCMilliseconds() === 0;
  if (!isMidnightThere) return dueAt;

  const pickedDay = asWritten.toISOString().slice(0, 10);
  return localDayStart(pickedDay)?.toISOString() ?? dueAt;
}

/**
 * Apply {@link normalizeDueAt} across a board, reporting whether anything moved
 * so the caller can say so once instead of per item.
 */
export function normalizeBoardDueDates(
  items: readonly WorkItem[],
): { items: WorkItem[]; changed: number } {
  let changed = 0;
  const next = items.map((item) => {
    if (item.due_at === undefined) return item;
    const due_at = normalizeDueAt(item.due_at);
    if (due_at === item.due_at) return item;
    changed += 1;
    return { ...item, due_at };
  });
  return { items: next, changed };
}
