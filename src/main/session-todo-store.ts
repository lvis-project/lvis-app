/**
 * SessionTodoStore — in-memory backing for the assistant's current-turn
 * checklist (`todo_session_write` LLM tool), keyed by active ChatSession so
 * renderer pushes route to the right view. Distinct from user `task_*`
 * persistence: never written to disk.
 *
 * State shape: sessionId → ordered array of {id, content, status}. Durable
 * item statuses are pending/in_progress/completed.
 *
 * Completed-plan clear is a deterministic two-step lifecycle so a finished
 * plan stays visible through the turn that completed it and clears exactly at
 * the next turn boundary, regardless of input origin:
 *
 *   1. mark (`markForClearIfCompleted`) — the post-turn hook chain runs after
 *      every turn. If the plan is fully completed it records the sessionId in
 *      `pendingClear` WITHOUT emitting, so the panel stays on screen for the
 *      turn that finished it.
 *   2. execute (`clearIfPending`) — at the next turn start the conversation
 *      loop drops any pending session unconditionally (delete + empty-list
 *      emit). No input-origin gate, so routine/headless turns clear too.
 *
 * Any `write(...)` that re-sets items drops the pending mark, so a plan that
 * changed after being marked is re-evaluated by the next post-turn hook rather
 * than firing a stale clear. Manual dismiss (`clear`) also drops the mark.
 *
 * Unfinished plans stay visible because they still represent active assistant
 * work. The update-only "deleted" command may remove items, but it must not
 * create the empty-list clear event.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import type { SessionTodoItem, SessionTodoUpdate } from "../shared/session-todo.js";
const log = createLogger("lvis");

export type SessionTodoListener = (
  sessionId: string,
  items: SessionTodoItem[],
) => void;

export class SessionTodoEmptyPlanError extends Error {
  constructor() {
    super("SessionTodoStore.write cannot remove every session TO-DO item");
    this.name = "SessionTodoEmptyPlanError";
  }
}

export class SessionTodoStore {
  private readonly sessions = new Map<string, SessionTodoItem[]>();
  private readonly listeners = new Set<SessionTodoListener>();
  /**
   * Sessions whose fully-completed plan was marked by the post-turn hook and
   * is awaiting clear at the next turn boundary. Never observable to listeners.
   */
  private readonly pendingClear = new Set<string>();

  list(sessionId: string): SessionTodoItem[] {
    const items = this.sessions.get(sessionId) ?? [];
    return items.map((i) => ({ ...i }));
  }

  /**
   * Merge an array of partial TO-DO updates by id.
   *
   * - missing id → new item
   * - existing id → update in place, optionally move by beforeId/afterId
   * - status=deleted → remove from the list
   *
   * Returns the merged ordered list.
   */
  write(sessionId: string, updates: SessionTodoUpdate[]): SessionTodoItem[] {
    const existing = this.sessions.get(sessionId) ?? [];
    const byId = new Map(existing.map((i) => [i.id, i]));
    const order: string[] = existing.map((i) => i.id);
    for (const u of updates) {
      const id = u.id ?? randomUUID();
      const existing = byId.get(id);
      const existingOrderIndex = order.indexOf(id);
      if (u.status === "deleted") {
        byId.delete(id);
        removeFromOrder(order, id);
        continue;
      }
      const item: SessionTodoItem = {
        id,
        content: u.content ?? existing?.content ?? "",
        status: u.status,
      };
      removeFromOrder(order, id);
      insertIntoOrder(order, id, {
        beforeId: u.beforeId,
        afterId: u.afterId,
        fallbackIndex: existingOrderIndex,
      });
      byId.set(id, item);
    }
    const merged: SessionTodoItem[] = order
      .map((id) => byId.get(id))
      .filter((x): x is SessionTodoItem => Boolean(x));
    if (merged.length === 0 && existing.length > 0) {
      throw new SessionTodoEmptyPlanError();
    }
    if (merged.length === 0) return [];
    this.sessions.set(sessionId, merged);
    // A write that re-sets items invalidates any prior completion mark: the
    // plan changed, so the next post-turn hook re-evaluates it from scratch.
    this.pendingClear.delete(sessionId);
    for (const l of this.listeners) {
      try {
        l(sessionId, merged.map((i) => ({ ...i })));
      } catch (err) {
        log.warn("session-todo listener threw: %s", (err as Error).message);
      }
    }
    return merged.map((i) => ({ ...i }));
  }

  /**
   * Mark step of the deterministic clear lifecycle (post-turn hook). Marks the
   * session for clear at the next turn boundary IFF it currently holds a
   * fully-completed plan. MUST NOT emit — the panel stays visible through the
   * turn that completed it. A no-longer-completed plan is defensively unmarked.
   *
   * @returns true when the session was marked, false otherwise.
   */
  markForClearIfCompleted(sessionId: string): boolean {
    const items = this.sessions.get(sessionId) ?? [];
    if (items.length > 0 && items.every((item) => item.status === "completed")) {
      this.pendingClear.add(sessionId);
      return true;
    }
    this.pendingClear.delete(sessionId);
    return false;
  }

  /**
   * Execute step of the deterministic clear lifecycle (next turn start). If the
   * session was marked by a prior post-turn hook, drop it now (delete + empty
   * emit) and consume the mark. Unconditional — no input-origin gate — so
   * routine/headless turns clear completed plans too.
   *
   * @returns true when a pending session was cleared, false otherwise.
   */
  clearIfPending(sessionId: string): boolean {
    if (!this.pendingClear.has(sessionId)) return false;
    this.clear(sessionId);
    return true;
  }

  /**
   * Explicit-clear path: drop the session and emit an empty list to listeners.
   * Used by both `clearIfPending` (deterministic next-turn execute) and the
   * manual dismiss affordance. Also drops any pending completion mark so a
   * dismissed plan cannot fire a stale clear. Distinct from the update-only
   * `deleted` command, which removes items but must never produce the
   * empty-list clear event.
   */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.pendingClear.delete(sessionId);
    for (const l of this.listeners) {
      try {
        l(sessionId, []);
      } catch {
        // ignore
      }
    }
  }

  onChange(listener: SessionTodoListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function removeFromOrder(order: string[], id: string): void {
  const idx = order.indexOf(id);
  if (idx >= 0) order.splice(idx, 1);
}

function insertIntoOrder(
  order: string[],
  id: string,
  position: { beforeId?: string; afterId?: string; fallbackIndex: number },
): void {
  const beforeIdx = position.beforeId ? order.indexOf(position.beforeId) : -1;
  if (beforeIdx >= 0) {
    order.splice(beforeIdx, 0, id);
    return;
  }
  const afterIdx = position.afterId ? order.indexOf(position.afterId) : -1;
  if (afterIdx >= 0) {
    order.splice(afterIdx + 1, 0, id);
    return;
  }
  if (position.fallbackIndex >= 0) {
    order.splice(Math.min(position.fallbackIndex, order.length), 0, id);
    return;
  }
  order.push(id);
}
