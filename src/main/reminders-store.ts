/**
 * Reminders Store — persistent backing for the `remind_at` LLM tool.
 *
 * Persists reminders to `~/.lvis/reminders.json` with an in-process async
 * mutex (mirroring `plugins/registry.ts` `withRegistryLock`) so concurrent
 * add/dismiss/restore operations cannot corrupt the file.
 *
 * The store is intentionally pure — it does not own a timer. The
 * {@link RemindersScheduler} (separate module) drives the polling loop and
 * fires `lvis:reminder:fired` IPC events when `at` is reached.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type ReminderRepeat = "daily" | "weekly" | "none";

export interface ReminderRecord {
  id: string;
  at: string;
  title: string;
  body?: string;
  repeat: ReminderRepeat;
  createdAt: string;
  /** Last time the reminder fired (recurring reminders advance `at` after firing). */
  lastFiredAt?: string;
  /** Set when the user explicitly dismisses the reminder via UI. */
  dismissedAt?: string;
}

export interface RemindersFile {
  version: 1;
  reminders: ReminderRecord[];
}

const DEFAULT_PATH = resolve(homedir(), ".lvis", "reminders.json");

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  fileLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

async function readFileOrEmpty(filePath: string): Promise<RemindersFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as RemindersFile;
    if (!Array.isArray(parsed.reminders)) {
      return { version: 1, reminders: [] };
    }
    return { version: 1, reminders: parsed.reminders };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, reminders: [] };
    }
    throw err;
  }
}

async function writeFileAtomic(filePath: string, data: RemindersFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export class RemindersStore {
  private cache: ReminderRecord[] = [];
  private loaded = false;
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_PATH) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const file = await readFileOrEmpty(this.filePath);
    this.cache = file.reminders;
    this.loaded = true;
  }

  list(): ReminderRecord[] {
    return [...this.cache];
  }

  /** Active reminders = not dismissed. */
  listActive(): ReminderRecord[] {
    return this.cache.filter((r) => !r.dismissedAt);
  }

  async add(input: {
    at: string;
    title: string;
    body?: string;
    repeat?: ReminderRepeat;
  }): Promise<ReminderRecord> {
    if (!this.loaded) await this.load();
    const record: ReminderRecord = {
      id: randomUUID(),
      at: new Date(input.at).toISOString(),
      title: input.title,
      body: input.body,
      repeat: input.repeat ?? "none",
      createdAt: new Date().toISOString(),
    };
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      file.reminders.push(record);
      await writeFileAtomic(this.filePath, file);
      this.cache = file.reminders;
      return record;
    });
  }

  async dismiss(id: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.reminders.find((x) => x.id === id);
      if (!r) {
        this.cache = file.reminders;
        return false;
      }
      r.dismissedAt = new Date().toISOString();
      await writeFileAtomic(this.filePath, file);
      this.cache = file.reminders;
      return true;
    });
  }

  async remove(id: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const before = file.reminders.length;
      file.reminders = file.reminders.filter((r) => r.id !== id);
      const removed = file.reminders.length !== before;
      await writeFileAtomic(this.filePath, file);
      this.cache = file.reminders;
      return removed;
    });
  }

  /**
   * Mark a reminder as fired. For non-repeating reminders, sets dismissedAt.
   * For daily/weekly reminders, advances `at` to the next occurrence.
   * Returns the updated record.
   */
  async markFired(id: string): Promise<ReminderRecord | null> {
    if (!this.loaded) await this.load();
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      const r = file.reminders.find((x) => x.id === id);
      if (!r) {
        this.cache = file.reminders;
        return null;
      }
      const firedAt = new Date().toISOString();
      r.lastFiredAt = firedAt;
      if (r.repeat === "daily" || r.repeat === "weekly") {
        const next = new Date(r.at);
        const incrementMs = r.repeat === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
        // Advance `at` until it's strictly in the future to handle long-asleep
        // sessions where multiple intervals were missed.
        const nowMs = Date.now();
        while (next.getTime() <= nowMs) {
          next.setTime(next.getTime() + incrementMs);
        }
        r.at = next.toISOString();
      } else {
        r.dismissedAt = firedAt;
      }
      await writeFileAtomic(this.filePath, file);
      this.cache = file.reminders;
      return r;
    });
  }
}
