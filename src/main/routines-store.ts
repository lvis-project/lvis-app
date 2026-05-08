/**
 * RoutinesStore v2 — persistent backing for the `schedule_routine` LLM tool.
 *
 * Persists routines to `~/.lvis/routines.json` with an in-process async mutex
 * (mirroring RemindersStore `withFileLock`) so concurrent add/dismiss operations
 * cannot corrupt the file.
 *
 * The store is intentionally pure — it does not own a timer. The
 * {@link RoutinesScheduler} (separate module) drives the polling loop and
 * fires execution events when a scheduled routine's next-fire time arrives.
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Hard cap on persisted routines (Q6). Hitting the cap means add() throws —
 * the LLM receives a clear error and can prompt the user to dismiss old routines.
 */
export const MAX_PERSISTED_ROUTINES = 50;

/** Maximum allowed distance into the future for schedule.at (parity with RemindersStore). */
const MAX_FUTURE_OFFSET_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

function validateScheduleAt(at: string): { ok: true } | { ok: false; error: string } {
  const ts = Date.parse(at);
  if (Number.isNaN(ts)) return { ok: false, error: "invalid-date" };
  const offset = ts - Date.now();
  if (offset > MAX_FUTURE_OFFSET_MS) {
    return { ok: false, error: "future-too-far" };
  }
  // Past timestamps are allowed — past-due routines fire immediately on next poll.
  return { ok: true };
}

export type RoutineExecution = "llm-session" | "notification-only";

export type RepeatKind =
  | "none"
  | "daily"
  | "weekly"
  | "monthly"
  | "interval"
  | "cron";

export type RoutineRepeat =
  | { kind: "none" }
  | { kind: "daily" }
  | { kind: "weekly" }
  | { kind: "monthly" }
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; expression: string };

export interface RoutineSchedule {
  /** ISO timestamp for the first (or one-time) fire. */
  at?: string;
  repeat?: RoutineRepeat;
}

export interface RoutineRecord {
  id: string;
  /** wakeup trigger is removed (Q1) — only schedule and shutdown remain. */
  trigger: "shutdown" | "schedule";
  schedule?: RoutineSchedule;
  execution: RoutineExecution;
  /** System prompt injected when execution === "llm-session". */
  prePrompt?: string;
  title?: string;
  /** Shown as OS notification title when execution === "notification-only". */
  notificationTitle?: string;
  /** Shown as OS notification body when execution === "notification-only". */
  notificationBody?: string;
  createdAt: string;
  lastFiredAt?: string;
  dismissedAt?: string;
  /**
   * Persistent cron dedup key — ISO string of the UTC minute that last fired.
   * Survives app restarts so the same cron minute cannot re-fire after reboot.
   */
  lastFiredMinuteUTC?: string;
}

export interface RoutinesFile {
  version: 2;
  routines: RoutineRecord[];
}

export interface AddRoutineInput {
  trigger: "shutdown" | "schedule";
  schedule?: RoutineSchedule;
  execution: RoutineExecution;
  prePrompt?: string;
  title?: string;
  notificationTitle?: string;
  notificationBody?: string;
}

const DEFAULT_PATH = resolve(homedir(), ".lvis", "routines.json");

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  fileLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

async function readFileOrEmpty(filePath: string): Promise<RoutinesFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as RoutinesFile;
    if (!Array.isArray(parsed.routines)) {
      return { version: 2, routines: [] };
    }
    return { version: 2, routines: parsed.routines };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, routines: [] };
    }
    throw err;
  }
}

async function writeFileAtomic(filePath: string, data: RoutinesFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}

export class RoutinesStore {
  private cache: RoutineRecord[] = [];
  private loaded = false;
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const file = await readFileOrEmpty(this.filePath);
    this.cache = file.routines;
    this.loaded = true;
  }

  list(): RoutineRecord[] {
    return [...this.cache];
  }

  /** Active routines = not dismissed. */
  listActive(): RoutineRecord[] {
    return this.cache.filter((r) => !r.dismissedAt);
  }

  async add(input: AddRoutineInput): Promise<RoutineRecord> {
    if (!this.loaded) await this.load();

    // Validate `at` when provided.
    if (input.schedule?.at !== undefined) {
      const validation = validateScheduleAt(input.schedule.at);
      if (!validation.ok) {
        throw new Error(
          `RoutinesStore.add: invalid schedule.at (${validation.error}): ${input.schedule.at}`,
        );
      }
    }

    const record: RoutineRecord = {
      id: randomUUID(),
      trigger: input.trigger,
      schedule: input.schedule,
      execution: input.execution,
      prePrompt: input.prePrompt,
      title: input.title,
      notificationTitle: input.notificationTitle,
      notificationBody: input.notificationBody,
      createdAt: new Date().toISOString(),
    };

    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      if (file.routines.length >= MAX_PERSISTED_ROUTINES) {
        throw new Error(
          `RoutinesStore.add: routine cap reached (${MAX_PERSISTED_ROUTINES}); dismiss/remove old routines first`,
        );
      }
      file.routines.push(record);
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      return record;
    });
  }

  async dismiss(id: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      if (!r) {
        this.cache = file.routines;
        return false;
      }
      r.dismissedAt = new Date().toISOString();
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      return true;
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const before = file.routines.length;
      file.routines = file.routines.filter((r) => r.id !== id);
      const removed = file.routines.length !== before;
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      return removed;
    });
  }

  /**
   * Patch a subset of mutable fields on a routine record.
   * Only the fields present in `patch` are written; undefined values are ignored.
   * Returns the updated record, or null if not found.
   */
  async update(
    id: string,
    patch: Partial<Pick<RoutineRecord, "lastFiredMinuteUTC" | "lastFiredAt" | "dismissedAt">>,
  ): Promise<RoutineRecord | null> {
    if (!this.loaded) await this.load();
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      if (!r) {
        this.cache = file.routines;
        return null;
      }
      if (patch.lastFiredMinuteUTC !== undefined) r.lastFiredMinuteUTC = patch.lastFiredMinuteUTC;
      if (patch.lastFiredAt !== undefined) r.lastFiredAt = patch.lastFiredAt;
      if (patch.dismissedAt !== undefined) r.dismissedAt = patch.dismissedAt;
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      return r;
    });
  }

  /**
   * Mark a routine as fired. For non-repeating routines, sets dismissedAt.
   * For repeating routines, advances the next-fire time using the cron evaluator.
   * Returns the updated record.
   */
  async markFired(id: string): Promise<RoutineRecord | null> {
    if (!this.loaded) await this.load();
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.routines.find((x) => x.id === id);
      if (!r) {
        this.cache = file.routines;
        return null;
      }
      const firedAt = new Date().toISOString();
      r.lastFiredAt = firedAt;
      const repeat = r.schedule?.repeat;
      if (!repeat || repeat.kind === "none") {
        r.dismissedAt = firedAt;
      } else if (repeat.kind === "daily") {
        const next = advanceDaily(r.schedule?.at ?? firedAt);
        if (!r.schedule) r.schedule = {};
        r.schedule.at = next;
      } else if (repeat.kind === "weekly") {
        const next = advanceWeekly(r.schedule?.at ?? firedAt);
        if (!r.schedule) r.schedule = {};
        r.schedule.at = next;
      } else if (repeat.kind === "monthly") {
        const next = advanceMonthly(r.schedule?.at ?? firedAt);
        if (!r.schedule) r.schedule = {};
        r.schedule.at = next;
      } else if (repeat.kind === "interval") {
        const next = advanceInterval(r.schedule?.at ?? firedAt, repeat.intervalMs);
        if (!r.schedule) r.schedule = {};
        r.schedule.at = next;
      }
      // cron routines: next-fire is re-computed by the scheduler each tick —
      // no need to advance `at` here.
      await writeFileAtomic(this.filePath, file);
      this.cache = file.routines;
      return r;
    });
  }
}

// ─── Next-fire helpers ────────────────────────────────────────────────────────

function advanceDaily(atIso: string): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  while (d.getTime() <= nowMs) {
    d.setTime(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return d.toISOString();
}

function advanceWeekly(atIso: string): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  while (d.getTime() <= nowMs) {
    d.setTime(d.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return d.toISOString();
}

/**
 * Advance by one calendar month, clamping to the last day of the target month
 * so 31-day routines don't skip February (Q5).
 */
function advanceMonthly(atIso: string): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  while (d.getTime() <= nowMs) {
    const dayOfMonth = d.getDate();
    const nextMonth = d.getMonth() + 1;
    // Attempt to set target month (may overflow to next if day > last-day).
    d.setMonth(nextMonth);
    // Clamp: if overflow happened (e.g. Jan 31 → Mar 3), rewind to last day.
    if (d.getMonth() !== ((nextMonth) % 12)) {
      // Overflowed — set to 0th day of overflow month = last day of target
      d.setDate(0);
    }
    // Restore day-of-month up to available max.
    const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    if (dayOfMonth < d.getDate() || d.getDate() > maxDay) {
      d.setDate(Math.min(dayOfMonth, maxDay));
    }
  }
  return d.toISOString();
}

function advanceInterval(atIso: string, intervalMs: number): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  if (intervalMs <= 0) return d.toISOString();
  while (d.getTime() <= nowMs) {
    d.setTime(d.getTime() + intervalMs);
  }
  return d.toISOString();
}
