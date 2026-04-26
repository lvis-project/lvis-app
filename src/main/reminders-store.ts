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
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * H4(c): refuse `at` values further than this many milliseconds in the
 * future. 5 years is far beyond any legitimate reminder horizon and
 * blocks attackers from staging a long-tail of dormant entries. Past
 * dates are allowed (they fire immediately on the next scheduler tick).
 */
const MAX_FUTURE_OFFSET_MS = 5 * 365 * 24 * 60 * 60 * 1000;
/**
 * H4(c): per-store cap on persisted reminders. The store is single-user
 * (host runs in-process per Electron window) so 50 active reminders is a
 * generous personal limit. Hitting the cap means add() throws — the LLM
 * receives a clear error and can prompt the user to dismiss old reminders.
 */
const MAX_PERSISTED_REMINDERS = 50;

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
  // H4(a): tighten directory permissions so `~/.lvis` is owner-only.
  // mkdir is idempotent and silently ignores `mode` on existing dirs, but
  // setting it on first creation is enough for fresh installs.
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  // H4(b): real atomic write — write to a sibling tmp file first, then
  // rename. A crash mid-write leaves either the previous content or the
  // new content, never a half-written file. The previous "writeFileAtomic"
  // overwrote in-place, which is not atomic on Windows or any FS without
  // a journal+fsync sequence.
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf-8",
    // H4(a): owner-only file mode (umask-independent).
    mode: 0o600,
  });
  await rename(tmp, filePath);
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
    // L3 + H4(c): validate the `at` field at the store boundary (caller
    // tools also validate, but defense in depth). Reject NaN, too-far-
    // future, and invalid ISO/Date inputs up front.
    const parsedAt = new Date(input.at);
    if (Number.isNaN(parsedAt.getTime())) {
      throw new Error(
        `RemindersStore.add: invalid 'at' (expected ISO 8601): ${input.at}`,
      );
    }
    const offset = parsedAt.getTime() - Date.now();
    if (offset > MAX_FUTURE_OFFSET_MS) {
      throw new Error(
        `RemindersStore.add: 'at' is too far in the future (>${Math.round(
          MAX_FUTURE_OFFSET_MS / (24 * 60 * 60 * 1000),
        )} days)`,
      );
    }
    const record: ReminderRecord = {
      id: randomUUID(),
      at: parsedAt.toISOString(),
      title: input.title,
      body: input.body,
      repeat: input.repeat ?? "none",
      createdAt: new Date().toISOString(),
    };
    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      // H4(c): per-store cap. We count *all* persisted reminders (active +
      // dismissed) since the renderer can resurrect dismissed ones via
      // remove/restore — a soft "dismissed" record still consumes storage.
      if (file.reminders.length >= MAX_PERSISTED_REMINDERS) {
        throw new Error(
          `RemindersStore.add: reminder cap reached (${MAX_PERSISTED_REMINDERS}); dismiss/remove old reminders first`,
        );
      }
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
