/**
 * SessionTodoStore — in-memory backing for the assistant's current-turn
 * checklist (`todo_session_write` LLM tool), keyed by active ChatSession so
 * renderer pushes route to the right view. Distinct from user `task_*`
 * persistence: never written to disk.
 *
 * State shape: sessionId → ordered array of {id, content, status}. Durable
 * item statuses are pending/in_progress/completed. Completed plans are cleared
 * at the next explicit user/user-queued turn boundary. Unfinished plans stay
 * visible because they still represent active assistant work. The update-only
 * "deleted" command may remove items, but it must not create the empty-list
 * clear event.
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
    for (const l of this.listeners) {
      try {
        l(sessionId, merged.map((i) => ({ ...i })));
      } catch (err) {
        log.warn("session-todo listener threw: %s", (err as Error).message);
      }
    }
    return merged.map((i) => ({ ...i }));
  }

  clearForTurnStart(sessionId: string): boolean {
    const items = this.sessions.get(sessionId) ?? [];
    if (items.length === 0) return false;
    if (!items.every((item) => item.status === "completed")) return false;
    this.clear(sessionId);
    return true;
  }

  /**
   * Explicit-clear path: drop the session and emit an empty list to listeners.
   * Used by both the turn-start auto-clear and the manual dismiss affordance.
   * Distinct from the update-only `deleted` command, which removes items but
   * must never produce the empty-list clear event.
   */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
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
