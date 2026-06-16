/**
 * Host "due soon" scanner for the Work Board.
 *
 * A subscribed `work-item-due-soon` detector consumes the plugin-bus event
 * `work_board.work_item.due_soon` { itemId, title, notifiedAt } to nudge the
 * user before a deadline. The board is now host-owned (architecture.md
 * §10.0.3), so the HOST emits this event under its own namespace: a scheduler
 * tick scans the board for not-yet-completed items whose `due_at` falls inside
 * the next 24h and fires one slim pointer event per item.
 *
 * The event was re-namespaced from the legacy plugin name during host
 * integration so host source carries no plugin-owned identifiers (the
 * decoupling audit); consumers subscribe to the host name in lock-step.
 *
 * Dedupe is keyed by `${id}:${due_at}` and persisted to
 * `due-soon-notified.json` under the work-board namespace, so an item fires at
 * most once for its current deadline, survives restarts, and re-fires only when
 * its `due_at` actually changes. Stale keys (item completed, deleted, or pushed
 * out of the window) are pruned every scan by rebuilding the map.
 *
 * No fallback: a missing notified file reads back as `null` (the storage
 * contract's "absent" signal), seeded as an empty map.
 */
import type { WorkBoardStorage } from "./storage.js";
import type {
  WorkItemListResult,
  WorkItemDueSoonEventPayload,
} from "../shared/work-board-types.js";

/** Pre-due lookahead window: an item is "due soon" within the next 24h. */
export const DUE_SOON_WINDOW_MS = 24 * 60 * 60_000;

/** Relative path (under the work-board namespace) of the dedupe map. */
export const DUE_SOON_NOTIFIED_FILE = "due-soon-notified.json";

/** Host event type consumed by a subscribed work-item-due-soon detector. */
export const DUE_SOON_EVENT = "work_board.work_item.due_soon";

/** Persisted dedupe map: `${id}:${due_at}` → ISO instant first notified. */
type DueSoonNotified = Record<string, string>;

/** Host event emitter — synchronous fire-and-forget, matching `emitEvent`. */
type EmitFn = (type: string, data?: unknown) => void;

/** Narrow board reader the scan needs (satisfied by WorkBoardStore). */
export interface DueSoonBoardReader {
  list(): Promise<WorkItemListResult>;
}

function notifiedKey(id: number, dueAt: string): string {
  return `${id}:${dueAt}`;
}

/**
 * Scan the board and emit `work_board.work_item.due_soon` for every
 * not-yet-completed item whose `due_at` is inside the half-open window
 * `[now, now + 24h)`, deduped by `(id, due_at)`. Returns the payloads emitted
 * on this scan (for logging / tests).
 */
export async function scanAndEmitDueSoon(
  store: DueSoonBoardReader,
  storage: WorkBoardStorage,
  emit: EmitFn,
  nowMs: number,
): Promise<WorkItemDueSoonEventPayload[]> {
  const listed = await store.list();
  if (listed.status !== "ok") return [];

  const prev = (await storage.readJson<DueSoonNotified>(DUE_SOON_NOTIFIED_FILE)) ?? {};
  const next: DueSoonNotified = {};
  const emitted: WorkItemDueSoonEventPayload[] = [];
  const nowIso = new Date(nowMs).toISOString();

  for (const item of listed.items) {
    if (item.status === "completed" || !item.due_at) continue;
    const due = Date.parse(item.due_at);
    // Half-open window [now, now+24h): a future deadline within 24h.
    // Past-due (overdue) items are NOT a "due soon" nudge.
    if (Number.isNaN(due) || due < nowMs || due >= nowMs + DUE_SOON_WINDOW_MS) continue;

    const key = notifiedKey(item.id, item.due_at);
    // Retain still-due-soon keys; rebuilding `next` from scratch prunes any
    // key whose item left the window (completed/deleted/rescheduled).
    next[key] = prev[key] ?? nowIso;
    if (prev[key] !== undefined) continue; // already notified for this deadline

    const payload: WorkItemDueSoonEventPayload = {
      itemId: item.id,
      title: item.title,
      notifiedAt: nowIso,
    };
    emit(DUE_SOON_EVENT, payload);
    emitted.push(payload);
  }

  // Persist only when the dedupe map actually changed (new fire or pruned key).
  if (JSON.stringify(prev) !== JSON.stringify(next)) {
    await storage.writeJson(DUE_SOON_NOTIFIED_FILE, next);
  }
  return emitted;
}
