/**
 * SessionTasksStore — the assistant's per-session checklist (`session_tasks`
 * LLM tool), keyed by ChatSession id so renderer pushes route to the right
 * tile. Distinct from user `task_*` persistence.
 *
 * State shape: sessionId → ordered array of {id, content, status}. Positions
 * are 1-based in every public mutation because that is the number the model
 * and the user both see; the store converts once at its boundary.
 *
 * Durability: the list is a field of the session's metadata sidecar
 * (`<id>.meta.json`), written through {@link SessionTasksPersistence} on every
 * mutation and read back lazily the first time a session is listed after
 * boot. Completed items stay in the list — finishing a step is a state, not a
 * deletion — so a reopened session shows the plan exactly as it was left.
 * Only the manual dismiss (`clear`) drops the list.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import type { SessionTaskItem } from "../shared/session-tasks.js";
const log = createLogger("lvis");

export type SessionTasksListener = (
  sessionId: string,
  items: SessionTaskItem[],
) => void;

/** Where a session's task list lives when this process is not holding it. */
export interface SessionTasksPersistence {
  load(sessionId: string): SessionTaskItem[];
  save(sessionId: string, items: SessionTaskItem[]): Promise<void>;
}

/** A 1-based position that names no task in the current list. */
export class SessionTaskIndexError extends Error {
  constructor(index: number, count: number) {
    super(
      count === 0
        ? `task ${index} does not exist: the list is empty`
        : `task ${index} does not exist: the list has tasks 1..${count}`,
    );
    this.name = "SessionTaskIndexError";
  }
}

export interface SessionTaskEdit {
  text?: string;
  status?: "pending" | "in_progress";
}

export class SessionTasksStore {
  private readonly sessions = new Map<string, SessionTaskItem[]>();
  private readonly listeners = new Set<SessionTasksListener>();

  constructor(private readonly persistence: SessionTasksPersistence) {}

  list(sessionId: string): SessionTaskItem[] {
    return this.current(sessionId).map((i) => ({ ...i }));
  }

  /** Replace the whole list with these steps, all pending. */
  create(sessionId: string, steps: string[]): Promise<SessionTaskItem[]> {
    return this.commit(sessionId, steps.map(newItem));
  }

  /**
   * Insert steps after task `after` (1-based). `0` inserts at the front;
   * omitted appends at the end.
   */
  add(sessionId: string, steps: string[], after?: number): Promise<SessionTaskItem[]> {
    const items = this.current(sessionId);
    const at = after ?? items.length;
    if (!Number.isInteger(at) || at < 0 || at > items.length) {
      throw new SessionTaskIndexError(at, items.length);
    }
    const next = [...items];
    next.splice(at, 0, ...steps.map(newItem));
    return this.commit(sessionId, next);
  }

  edit(sessionId: string, index: number, patch: SessionTaskEdit): Promise<SessionTaskItem[]> {
    const items = this.current(sessionId);
    const target = items[this.position(index, items)];
    const next = items.map((item) =>
      item === target
        ? {
            ...item,
            content: patch.text ?? item.content,
            status: patch.status ?? item.status,
          }
        : item,
    );
    return this.commit(sessionId, next);
  }

  delete(sessionId: string, index: number): Promise<SessionTaskItem[]> {
    const items = this.current(sessionId);
    const at = this.position(index, items);
    return this.commit(sessionId, items.filter((_, i) => i !== at));
  }

  complete(sessionId: string, index: number): Promise<SessionTaskItem[]> {
    const items = this.current(sessionId);
    const at = this.position(index, items);
    return this.commit(
      sessionId,
      items.map((item, i) => (i === at ? { ...item, status: "completed" as const } : item)),
    );
  }

  /** Manual dismiss: drop the list (memory + sidecar) and emit an empty list. */
  clear(sessionId: string): Promise<SessionTaskItem[]> {
    return this.commit(sessionId, []);
  }

  onChange(listener: SessionTasksListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private current(sessionId: string): SessionTaskItem[] {
    const held = this.sessions.get(sessionId);
    if (held) return held;
    const loaded = this.persistence.load(sessionId);
    this.sessions.set(sessionId, loaded);
    return loaded;
  }

  private position(index: number, items: SessionTaskItem[]): number {
    if (!Number.isInteger(index) || index < 1 || index > items.length) {
      throw new SessionTaskIndexError(index, items.length);
    }
    return index - 1;
  }

  /**
   * Sidecar first, memory second: a failed write leaves the held list as it
   * was, so what the chip shows never runs ahead of what a restart would
   * bring back.
   */
  private async commit(sessionId: string, next: SessionTaskItem[]): Promise<SessionTaskItem[]> {
    await this.persistence.save(sessionId, next);
    this.sessions.set(sessionId, next);
    for (const l of this.listeners) {
      try {
        l(sessionId, next.map((i) => ({ ...i })));
      } catch (err) {
        log.warn("session-tasks listener threw: %s", (err as Error).message);
      }
    }
    return next.map((i) => ({ ...i }));
  }
}

function newItem(content: string): SessionTaskItem {
  return { id: randomUUID(), content, status: "pending" };
}
