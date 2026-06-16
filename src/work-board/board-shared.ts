/**
 * Shared work-board primitives.
 *
 * This module is NOT a store — it holds the pure, side-effect-free pieces the
 * board CRUD store ({@link WorkBoardStore}) depends on: the on-disk board shape,
 * the schema version, and the `overdue` projection rule. The single CRUD
 * implementation lives in `src/main/work-board-store.ts`; keeping these
 * primitives here (rather than re-deriving them per consumer) means the
 * `status_resolved` rule has exactly one definition.
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
export function resolveStatus(
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
