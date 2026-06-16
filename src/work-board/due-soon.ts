/**
 * "Due soon" emitter for the personal work board.
 *
 * The work board is fully local — there is no server-polled inbox. On the
 * scheduler tick (and once at start) this scans the board for not-yet-completed
 * items whose `due_at` falls inside the next 24h and fires one slim pointer
 * event per item. Proactive plugins subscribe to the event (via the plugin bus)
 * to nudge the user before a deadline; the host never invokes a specific plugin
 * by id — emission is capability-driven.
 *
 * Dedupe is keyed by `${id}:${due_at}` and persisted to
 * `due-soon-notified.json` (under `~/.lvis/work-board/`, via the injected
 * {@link WorkBoardStorage} seam) so an item fires at most once for its current
 * deadline, survives restarts, and re-fires only when its `due_at` actually
 * changes. Stale keys (item completed, deleted, or pushed back out of the
 * window) are pruned on every scan so the map never grows unbounded.
 *
 * No remote. No fallback: a missing notified file is the storage contract's
 * "absent" signal (first run), seeded as an empty map.
 */
import type {
  WorkItemDueSoonEventPayload,
  WorkItemResolved,
} from "../shared/work-board-types.js";
import type { WorkBoardStorage } from "./storage.js";

/**
 * Minimal read surface the scanner needs from the board: a single `list()` that
 * yields every item with its `status_resolved` projection already computed. The
 * live {@link WorkBoardStore} satisfies this once its envelope is unwrapped at
 * the call site, and an in-memory fake satisfies it directly in tests — neither
 * couples the scanner to a concrete store class.
 */
export interface BoardReader {
  list(): Promise<WorkItemResolved[]>;
}

/** Pre-due lookahead window: an item is "due soon" within the next 24h. */
export const DUE_SOON_WINDOW_MS = 24 * 60 * 60_000;

/** Relative path (under the feature dir) of the dedupe map. */
export const DUE_SOON_NOTIFIED_FILE = "due-soon-notified.json";

/** Plugin-bus event type emitted when an item's deadline enters the pre-due window. */
export const DUE_SOON_EVENT = "work_board.work_item.due_soon";

/**
 * Persisted dedupe map: `${id}:${due_at}` → ISO instant it was first notified.
 * The value is informational (the live `notifiedAt` is freshly stamped on each
 * emit); presence of the key is what suppresses a re-fire.
 */
export type DueSoonNotified = Record<string, string>;

/** Host event emitter — synchronous fire-and-forget, matching `hostApi.emitEvent`. */
interface EmitFn {
  (type: string, data?: unknown): void;
}

/** Narrow slice of the storage seam the dedupe map needs. */
export type DueSoonStorage = Pick<WorkBoardStorage, "readJson" | "writeJson">;

/** Build the dedupe key for an item at its current deadline. */
function notifiedKey(id: number, dueAt: string): string {
  return `${id}:${dueAt}`;
}

/**
 * Scan the local board and emit the due-soon event for every not-yet-completed
 * item whose `due_at` is inside `[now, now + 24h)` and that has not already
 * fired for that exact deadline.
 *
 * - Window is half-open: an item exactly at `now` is still "due soon"; an item
 *   already in the past is `overdue`, not due-soon, and is skipped.
 * - The notified map is rebuilt to contain only keys for items that are still
 *   due-soon on this scan, so completing / rescheduling / deleting an item
 *   prunes its key and lets a later re-entry into the window fire again.
 * - The map is persisted only when it actually changed (a fire happened or a
 *   stale key was pruned) to avoid needless writes.
 *
 * @returns the payloads emitted on this scan (for logging / tests).
 */
export async function scanAndEmitDueSoon(
  store: BoardReader,
  storage: DueSoonStorage,
  emit: EmitFn,
  nowMs: number,
): Promise<WorkItemDueSoonEventPayload[]> {
  const items = await store.list();
  const prior =
    (await storage.readJson<DueSoonNotified>(DUE_SOON_NOTIFIED_FILE)) ?? {};

  const windowEnd = nowMs + DUE_SOON_WINDOW_MS;
  const next: DueSoonNotified = {};
  const emitted: WorkItemDueSoonEventPayload[] = [];
  const nowIso = new Date(nowMs).toISOString();

  for (const item of items) {
    // Completed items never nudge. Items with no deadline can't be due-soon.
    if (item.status === "completed" || item.due_at === undefined) continue;
    const dueMs = Date.parse(item.due_at);
    if (Number.isNaN(dueMs)) continue;
    // Half-open window [now, now+24h): past-due is `overdue`, not due-soon.
    if (dueMs < nowMs || dueMs >= windowEnd) continue;

    const key = notifiedKey(item.id, item.due_at);
    if (key in prior) {
      // Already fired for this exact deadline — carry the key forward, no emit.
      next[key] = prior[key];
      continue;
    }
    const payload: WorkItemDueSoonEventPayload = {
      itemId: item.id,
      title: item.title,
      notifiedAt: nowIso,
    };
    emit(DUE_SOON_EVENT, payload);
    emitted.push(payload);
    next[key] = nowIso;
  }

  // Persist only when the map changed — a fire added a key, or a stale key
  // (item completed / rescheduled / deleted / aged out) was dropped.
  const priorKeys = Object.keys(prior);
  const changed =
    priorKeys.length !== Object.keys(next).length ||
    priorKeys.some((k) => !(k in next));
  if (changed) {
    await storage.writeJson(DUE_SOON_NOTIFIED_FILE, next, 2);
  }

  return emitted;
}
