/**
 * SessionTodoStore — in-memory backing for the assistant's per-session
 * checklist (`todo_session_write` LLM tool). Distinct from user `task_*`
 * persistence: scope is the active ChatSession only, never written to disk.
 *
 * State shape: sessionId → ordered array of {id, content, status}. "deleted"
 * status is preserved so the renderer can render strikethroughs / undo
 * affordances rather than removing items outright.
 */
import { randomUUID } from "node:crypto";

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
  content: string;
  status: SessionTodoStatus;
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
   * Merge an array of partial todos by id. Items missing an id receive a
   * fresh UUID. Returns the merged ordered list.
   */
  write(sessionId: string, updates: SessionTodoUpdate[]): SessionTodoItem[] {
    const existing = this.sessions.get(sessionId) ?? [];
    const byId = new Map(existing.map((i) => [i.id, i]));
    const order: string[] = existing.map((i) => i.id);
    for (const u of updates) {
      const id = u.id ?? randomUUID();
      const item: SessionTodoItem = {
        id,
        content: u.content,
        status: u.status,
      };
      if (!byId.has(id)) {
        order.push(id);
      }
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
        console.warn("[lvis] session-todo listener threw:", (err as Error).message);
      }
    }
    return merged.map((i) => ({ ...i }));
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
