import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type TaskSource = string;
export type TaskPriority = "high" | "medium" | "low";
export type TaskStatus = "pending" | "done" | "snoozed";

export interface Task {
  id: string;
  title: string;
  description?: string;
  source: TaskSource;
  sourceRef?: string; // 원본 이메일 ID, 미팅 세션 ID 등
  priority: TaskPriority;
  status: TaskStatus;
  dueAt?: string; // ISO 8601
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  snoozeUntil?: string; // ISO 8601
}

export interface TaskFilter {
  source?: TaskSource;
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority;
  dueBefore?: string;
  dueAfter?: string;
}

export interface TaskServiceOptions {
  dbPath: string;
}

export class TaskService {
  private readonly db: Database.Database;

  constructor(options: TaskServiceOptions) {
    const dbPath = resolve(options.dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT,
        source      TEXT NOT NULL,
        source_ref  TEXT,
        priority    TEXT NOT NULL DEFAULT 'medium',
        status      TEXT NOT NULL DEFAULT 'pending',
        due_at      TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        snooze_until TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks (status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_at   ON tasks (due_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_source   ON tasks (source);
    `);
  }

  add(task: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
    const now = new Date().toISOString();
    const newTask: Task = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...task,
    };
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, title, description, source, source_ref, priority, status, due_at, created_at, updated_at, snooze_until)
         VALUES
           (@id, @title, @description, @source, @sourceRef, @priority, @status, @dueAt, @createdAt, @updatedAt, @snoozeUntil)`,
      )
      .run(this.toRow(newTask));
    return newTask;
  }

  update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task {
    const existing = this.get(id);
    if (!existing) throw new Error(`Task not found: ${id}`);
    const updated: Task = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE tasks SET
           title        = @title,
           description  = @description,
           source       = @source,
           source_ref   = @sourceRef,
           priority     = @priority,
           status       = @status,
           due_at       = @dueAt,
           updated_at   = @updatedAt,
           snooze_until = @snoozeUntil
         WHERE id = @id`,
      )
      .run(this.toRow(updated));
    return updated;
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  query(filter: TaskFilter = {}): Task[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.source) {
      conditions.push("source = @source");
      params.source = filter.source;
    }
    if (filter.priority) {
      conditions.push("priority = @priority");
      params.priority = filter.priority;
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      conditions.push(`status IN (${statuses.map((_, i) => `@status${i}`).join(", ")})`);
      statuses.forEach((s, i) => (params[`status${i}`] = s));
    }
    if (filter.dueBefore) {
      conditions.push("due_at IS NOT NULL AND due_at <= @dueBefore");
      params.dueBefore = filter.dueBefore;
    }
    if (filter.dueAfter) {
      conditions.push("due_at IS NOT NULL AND due_at >= @dueAfter");
      params.dueAfter = filter.dueAfter;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`)
      .all(params) as DbRow[];
    return rows.map((r) => this.fromRow(r));
  }

  // 브리핑용 메서드

  getPendingByPriority(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'pending'
         ORDER BY
           CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           due_at ASC NULLS LAST,
           created_at ASC`,
      )
      .all() as DbRow[];
    return rows.map((r) => this.fromRow(r));
  }

  getOverdue(): Task[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'pending' AND due_at IS NOT NULL AND due_at < @now
         ORDER BY due_at ASC`,
      )
      .all({ now }) as DbRow[];
    return rows.map((r) => this.fromRow(r));
  }

  getDueToday(): Task[] {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'pending'
           AND due_at IS NOT NULL
           AND due_at >= @start
           AND due_at <= @end
         ORDER BY due_at ASC`,
      )
      .all({ start: startOfDay.toISOString(), end: endOfDay.toISOString() }) as DbRow[];
    return rows.map((r) => this.fromRow(r));
  }

  close(): void {
    this.db.close();
  }

  // Row 변환 헬퍼

  private toRow(task: Task): WriteParams {
    return {
      id: task.id,
      title: task.title,
      description: task.description ?? null,
      source: task.source,
      sourceRef: task.sourceRef ?? null,
      priority: task.priority,
      status: task.status,
      dueAt: task.dueAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      snoozeUntil: task.snoozeUntil ?? null,
    };
  }

  private fromRow(row: DbRow): Task {
    return {
      id: row.id,
      title: row.title,
      ...(row.description != null && { description: row.description }),
      source: row.source as TaskSource,
      ...(row.source_ref != null && { sourceRef: row.source_ref }),
      priority: row.priority as TaskPriority,
      status: row.status as TaskStatus,
      ...(row.due_at != null && { dueAt: row.due_at }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.snooze_until != null && { snoozeUntil: row.snooze_until }),
    };
  }
}

// SQL INSERT/UPDATE 파라미터 (camelCase → @camelCase 바인딩)
interface WriteParams {
  id: string;
  title: string;
  description: string | null;
  source: string;
  sourceRef: string | null;
  priority: string;
  status: string;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  snoozeUntil: string | null;
}

// DB SELECT 결과 (snake_case 컬럼명 그대로)
interface DbRow {
  id: string;
  title: string;
  description: string | null;
  source: string;
  source_ref: string | null;
  priority: string;
  status: string;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  snooze_until: string | null;
}
