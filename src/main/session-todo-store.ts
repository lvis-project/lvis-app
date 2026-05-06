/**
 * SessionTodoStore — in-memory backing for the assistant's per-session
 * checklist (`todo_session_write` LLM tool). Distinct from user `task_*`
 * persistence: scope is the active ChatSession only, never written to disk.
 *
 * State shape: sessionId → ordered array of {id, content, status}. "deleted"
 * is a command state, not a durable row state: deleted items are removed from
 * the active list so the panel represents the runnable plan, not an audit log.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export type SessionTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "deleted";

export interface SessionTodoItem {
  id: string;
  content: string;
  status: SessionTodoStatus;
}

export interface SessionTodoUpdate {
  id?: string;
  content?: string;  // omit to keep existing content when updating by id
  status: SessionTodoStatus;
  /** Insert or move this item before another item id. Wins over afterId. */
  beforeId?: string;
  /** Insert or move this item after another item id. Appends if target missing. */
  afterId?: string;
}

export type SessionTodoListener = (
  sessionId: string,
  items: SessionTodoItem[],
) => void;

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

  clearIfAllCompleted(sessionId: string): boolean {
    const items = this.sessions.get(sessionId) ?? [];
    if (items.length === 0) return false;
    if (!items.every((i) => i.status === "completed")) return false;
    this.clear(sessionId);
    return true;
  }

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
