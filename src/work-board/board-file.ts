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
