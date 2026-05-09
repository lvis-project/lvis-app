/**
 * RoutinesStore v2 — persistent backing for the `schedule_routine` LLM tool.
 *
 * Persists routines to `~/.lvis/routine/routines.json` with an in-process async mutex
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
import { isValidCronExpression } from "../routines/cron-evaluator.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

// Re-export from shared so callers that import from routines-store continue
// to work unchanged, while the renderer imports from shared/ (no Node built-ins).
export {
  MAX_PERSISTED_ROUTINES,
  MAX_LLM_SESSION_ROUTINES,
  type RoutineExecution,
  type RepeatKind,
  type RoutineRepeat,
  type RoutineSchedule,
  type RoutineRecord,
  type RoutineScope,
  type RoutinePluginScope,
  type AddRoutineInput,
} from "../shared/routines-types.js";

import type {
  RoutineExecution,
  RoutineRepeat,
  RoutineRecord,
  RoutineSchedule,
  RoutineScope,
  AddRoutineInput,
} from "../shared/routines-types.js";
import { MAX_PERSISTED_ROUTINES, MAX_LLM_SESSION_ROUTINES } from "../shared/routines-types.js";

/** Maximum allowed distance into the future for schedule.at (parity with RemindersStore). */
const MAX_FUTURE_OFFSET_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

/** Maximum cron expression length (prevents regex DoS). Must match schedule-routine.ts. */
const MAX_CRON_EXPR_LENGTH = 256;

/** Minimum interval in ms (1 minute — prevents sub-minute polling spam). */
const MIN_INTERVAL_MS = 60_000;

/**
 * Validate a record loaded from disk. Rejects tampered / corrupted entries
 * so a single bad record cannot infect the scheduler tick.
 */
function isValidRecord(r: unknown): r is RoutineRecord {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  if (typeof x.id !== "string" || x.id.length > 128) return false;
  if (x.trigger !== "schedule" && x.trigger !== "shutdown") return false;
  if (x.execution !== "llm-session" && x.execution !== "notification-only") return false;
  if (x.lastFiredMinuteUTC !== undefined && typeof x.lastFiredMinuteUTC !== "string") return false;
  return true;
}

/**
 * Q12 Layer 4 — convert a legacy on-disk `allowedPlugins` (or absence)
 * into the canonical `scope` shape. Migration rules per design §3.4:
 *   - missing field          → `{ mode: "deny-all" }` (fail-safe)
 *   - empty array `[]`       → `{ mode: "deny-all" }`
 *   - non-empty array of strings → `{ mode: "allow", ids: [...] }`
 *   - tampered / non-string  → `{ mode: "deny-all" }` + warn
 *
 * The mutation is idempotent: a record that already has `scope` is
 * returned untouched (and the legacy field, if also present, ignored).
 *
 * Round 3 hardening: explicit `Array.isArray` + every-string check
 * before length/spread — a corrupt record with `allowedPlugins: "foo"`
 * (string, not array) or `[1, 2]` (numbers) was previously passing
 * `isValidRecord()` (which only validates structural fields) and
 * crashing the migration with a runtime error. Now we coerce any
 * shape we don't recognize to deny-all (fail-safe per spec §1).
 */
function migrateLegacyAllowedPlugins(rec: RoutineRecord & { allowedPlugins?: unknown }): RoutineRecord {
  if (rec.scope) {
    // Already the new shape — drop any stale legacy mirror.
    if ("allowedPlugins" in rec) {
      const cleaned = { ...rec };
      delete (cleaned as { allowedPlugins?: unknown }).allowedPlugins;
      return cleaned;
    }
    return rec;
  }
  const legacy = rec.allowedPlugins;
  let pluginIds: RoutineScope["pluginIds"];
  if (legacy === undefined) {
    // Q12 §3 fail-safe: missing scope → deny-all rather than inherit
    // (parity with normalizeScope at runtime; covers boot-time race
    // where active plugin set isn't computable yet).
    pluginIds = { mode: "deny-all" };
  } else if (Array.isArray(legacy) && legacy.every((x): x is string => typeof x === "string")) {
    pluginIds =
      legacy.length === 0
        ? { mode: "deny-all" }
        : { mode: "allow", ids: [...legacy] };
  } else {
    // Tampered or corrupt — fail-safe to deny-all and warn.
    log.warn(
      "[routines-store] legacy allowedPlugins has invalid shape (id=%s); coercing to deny-all",
      rec.id,
    );
    pluginIds = { mode: "deny-all" };
  }
  const migrated: RoutineRecord = {
    ...rec,
    scope: {
      pluginIds,
      forcedPluginIds: [],
      directories: [],
    },
  };
  delete (migrated as { allowedPlugins?: unknown }).allowedPlugins;
  return migrated;
}

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

export interface RoutinesFile {
  version: 2;
  routines: RoutineRecord[];
}

// Q9: consolidated under ~/.lvis/routine/ namespace (single directory for all routine data)
const DEFAULT_PATH = resolve(homedir(), ".lvis", "routine", "routines.json");

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
    let parsed: RoutinesFile;
    try {
      parsed = JSON.parse(raw) as RoutinesFile;
    } catch (err) {
      log.warn("[routines-store] corrupt JSON, treating as empty + backup");
      await rename(filePath, `${filePath}.corrupt-${Date.now()}.bak`);
      return { version: 2, routines: [] };
    }
    if (!Array.isArray(parsed.routines)) {
      return { version: 2, routines: [] };
    }
    // Filter out tampered/corrupted records so a single bad entry cannot
    // cause the scheduler tick to throw and stall all other routines.
    // Q12 Layer 4 — migrate legacy `allowedPlugins` to `scope` shape on read.
    return {
      version: 2,
      routines: parsed.routines
        .filter(isValidRecord)
        .map((r) => migrateLegacyAllowedPlugins(r as RoutineRecord & { allowedPlugins?: string[] })),
    };
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

/** Deep clone a RoutineRecord to prevent callers from mutating shared cache refs. */
function cloneRecord(r: RoutineRecord): RoutineRecord {
  return {
    ...r,
    schedule: r.schedule
      ? {
          ...r.schedule,
          repeat: r.schedule.repeat ? { ...r.schedule.repeat } : undefined,
        }
      : undefined,
    scope: r.scope
      ? {
          pluginIds:
            r.scope.pluginIds.mode === "allow"
              ? { mode: "allow", ids: [...r.scope.pluginIds.ids] }
              : { ...r.scope.pluginIds },
          forcedPluginIds: [...r.scope.forcedPluginIds],
          directories: [...r.scope.directories],
        }
      : undefined,
  };
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
    // M5: deep clone to prevent callers from mutating shared cache refs
    return this.cache.map(cloneRecord);
  }

  /** Active routines = not dismissed. */
  listActive(): RoutineRecord[] {
    return this.cache.filter((r) => !r.dismissedAt).map(cloneRecord);
  }

  async add(input: AddRoutineInput): Promise<RoutineRecord> {
    if (!this.loaded) await this.load();

    // Validate and normalize `at` to canonical ISO string when provided.
    let normalizedAt: string | undefined;
    if (input.schedule?.at !== undefined) {
      const validation = validateScheduleAt(input.schedule.at);
      if (!validation.ok) {
        throw new Error(
          `RoutinesStore.add: invalid schedule.at (${validation.error}): ${input.schedule.at}`,
        );
      }
      normalizedAt = new Date(input.schedule.at).toISOString();
    }

    // Validate that non-cron repeats always have schedule.at.
    // Without it, RoutinesScheduler.isDue() can never match and the routine
    // silently never fires — a hard error is strictly better than silent failure.
    if (input.schedule?.repeat) {
      const kind = input.schedule.repeat.kind;
      if (kind !== "cron" && !input.schedule.at) {
        throw new Error(
          `RoutinesStore.add: schedule.at is required for repeat.kind="${kind}" (non-cron repeats fire on a fixed instant)`,
        );
      }
    }

    // Validate cron expression when repeat.kind === 'cron'.
    if (input.schedule?.repeat?.kind === "cron") {
      const expr = (input.schedule.repeat as { kind: "cron"; expression: string }).expression;
      if (typeof expr !== "string" || expr.length > MAX_CRON_EXPR_LENGTH) {
        throw new Error(
          `RoutinesStore.add: cron expression too long or invalid type (max ${MAX_CRON_EXPR_LENGTH} chars)`,
        );
      }
      if (!expr.trim() || !isValidCronExpression(expr)) {
        throw new Error(
          `RoutinesStore.add: invalid cron expression: ${String(expr)}`,
        );
      }
    }

    // Validate intervalMs bounds when repeat.kind === 'interval'.
    if (input.schedule?.repeat?.kind === "interval") {
      const intervalMs = (input.schedule.repeat as { kind: "interval"; intervalMs: number }).intervalMs;
      if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_FUTURE_OFFSET_MS) {
        throw new Error(
          `RoutinesStore.add: intervalMs out of range (min ${MIN_INTERVAL_MS}ms, max ${MAX_FUTURE_OFFSET_MS}ms): ${String(intervalMs)}`,
        );
      }
    }

    // Validate execution-mode-specific required fields.
    if (input.execution === "llm-session") {
      if (!input.prePrompt || input.prePrompt.trim().length === 0) {
        throw new Error(
          "RoutinesStore.add: prePrompt is required and must be non-empty for execution='llm-session'",
        );
      }
    }
    if (input.execution === "notification-only") {
      if (!input.notificationTitle || input.notificationTitle.trim().length === 0) {
        throw new Error(
          "RoutinesStore.add: notificationTitle is required and must be non-empty for execution='notification-only'",
        );
      }
    }
    // Q12 Layer 4 — `scope` is the canonical shape. When omitted, default
    // to `{ pluginIds: inherit, forcedPluginIds: [], directories: [] }`.
    const inputScope = input.scope;
    const ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
    if (inputScope?.pluginIds.mode === "allow") {
      const trimmed = inputScope.pluginIds.ids.map((p) => p.trim()).filter(Boolean);
      if (trimmed.some((p) => !ID_RE.test(p))) {
        throw new Error(
          "RoutinesStore.add: scope.pluginIds.ids entries must be plugin ids using letters, digits, dot, underscore, or hyphen",
        );
      }
      // Replace with normalized + deduped values inside the discriminated union.
      inputScope.pluginIds = { mode: "allow", ids: [...new Set(trimmed)] };
    }
    if (inputScope?.forcedPluginIds) {
      const trimmedForced = inputScope.forcedPluginIds.map((p) => p.trim()).filter(Boolean);
      if (trimmedForced.some((p) => !ID_RE.test(p))) {
        throw new Error(
          "RoutinesStore.add: scope.forcedPluginIds entries must be plugin ids using letters, digits, dot, underscore, or hyphen",
        );
      }
      inputScope.forcedPluginIds = [...new Set(trimmedForced)];
    }
    const normalizedScope: RoutineScope = inputScope
      ? {
          pluginIds: inputScope.pluginIds,
          forcedPluginIds: inputScope.forcedPluginIds ?? [],
          directories: inputScope.directories ?? [],
        }
      : {
          pluginIds: { mode: "inherit" },
          forcedPluginIds: [],
          directories: [],
        };

    // Build schedule with normalized `at`.
    const normalizedSchedule: typeof input.schedule = input.schedule
      ? {
          ...input.schedule,
          ...(normalizedAt !== undefined ? { at: normalizedAt } : {}),
        }
      : undefined;

    const record: RoutineRecord = {
      id: randomUUID(),
      trigger: input.trigger,
      schedule: normalizedSchedule,
      execution: input.execution,
      prePrompt: input.prePrompt,
      title: input.title,
      notificationTitle: input.notificationTitle,
      notificationBody: input.notificationBody,
      scope: normalizedScope,
      createdAt: new Date().toISOString(),
    };

    return withFileLock(this.filePath, async () => {
      const file = await readFileOrEmpty(this.filePath);
      // Q8: llm-session sub-cap check (before total cap to give a specific error).
      if (record.execution === "llm-session") {
        const llmCount = file.routines.filter(
          (r) => r.execution === "llm-session" && !r.dismissedAt,
        ).length;
        if (llmCount >= MAX_LLM_SESSION_ROUTINES) {
          throw new Error(
            `RoutinesStore.add: LLM session routine cap reached (${MAX_LLM_SESSION_ROUTINES}); dismiss/remove old LLM routines first`,
          );
        }
      }
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
  if (d.getTime() <= nowMs) {
    const intervalMs = 24 * 60 * 60 * 1000;
    const elapsed = nowMs - d.getTime();
    const skips = Math.ceil(elapsed / intervalMs);
    d.setTime(d.getTime() + skips * intervalMs);
  }
  return d.toISOString();
}

function advanceWeekly(atIso: string): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  if (d.getTime() <= nowMs) {
    const intervalMs = 7 * 24 * 60 * 60 * 1000;
    const elapsed = nowMs - d.getTime();
    const skips = Math.ceil(elapsed / intervalMs);
    d.setTime(d.getTime() + skips * intervalMs);
  }
  return d.toISOString();
}

/**
 * Advance by one calendar month, clamping to the last day of the target month
 * so 31-day routines don't skip February (Q5).
 *
 * originalDay is captured once before the loop so that multi-month advances
 * (e.g. Jan 31 skipped while app was offline) correctly restore the original
 * day each month rather than drifting toward 28 after a Feb clamp.
 */
function advanceMonthly(atIso: string): string {
  const d = new Date(atIso);
  const originalDay = d.getUTCDate(); // capture once — never re-read from d
  const nowMs = Date.now();
  while (d.getTime() <= nowMs) {
    // Set day=1 first to avoid month-overflow when current day > target-month days.
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    // Clamp to last day of the new month, then restore originalDay.
    const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, maxDay));
  }
  return d.toISOString();
}

function advanceInterval(atIso: string, intervalMs: number): string {
  const d = new Date(atIso);
  const nowMs = Date.now();
  if (intervalMs <= 0) return d.toISOString();
  if (d.getTime() <= nowMs) {
    const elapsed = nowMs - d.getTime();
    const skips = Math.ceil(elapsed / intervalMs);
    d.setTime(d.getTime() + skips * intervalMs);
  }
  return d.toISOString();
}
