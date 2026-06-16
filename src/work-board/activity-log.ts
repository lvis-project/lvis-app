/**
 * Append-only work-flow activity log.
 *
 * One JSON event per line in `activity.jsonl` under the work-board feature
 * namespace. Every board mutation appends an event; report generation reads the
 * log back to understand the work flow. Reads/writes go through the injected
 * {@link WorkBoardStorage} seam (the host feature namespace) — no raw `fs`, no
 * fallback paths.
 */
import type { WorkBoardStorage } from "./storage.js";

/** Relative path (under the feature dir) of the activity log. */
export const ACTIVITY_FILE = "activity.jsonl";

/**
 * One work-flow event. `kind` mirrors the board lifecycle verbs. `from`/`to`
 * carry the status transition when `kind === "transitioned"`.
 */
export interface ActivityEvent {
  /** ISO-8601 timestamp. Filled in by `appendActivity` when omitted. */
  ts: string;
  kind:
    | "created"
    | "updated"
    | "completed"
    | "reopened"
    | "transitioned"
    | "deleted";
  itemId?: number;
  title?: string;
  from?: string;
  to?: string;
}

/**
 * Narrow slice of the storage seam the activity log depends on. `readText`
 * returns the full file; `write` replaces it (JSONL has no native append in the
 * storage API, so we read-modify-write the trailing line). `exists` gates the
 * first read.
 */
export type ActivityStorage = Pick<
  WorkBoardStorage,
  "readText" | "write" | "exists"
>;

/**
 * Append one event to the log. `ts` defaults to now when the caller omits it.
 * Read-modify-write because the storage API exposes no native append; the log
 * is bounded by the board size (one line per mutation) so this stays cheap.
 */
export async function appendActivity(
  storage: ActivityStorage,
  event: Omit<ActivityEvent, "ts"> & { ts?: string },
): Promise<void> {
  const full: ActivityEvent = {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
  };
  const line = JSON.stringify(full) + "\n";
  // First write: file absent → start fresh. `exists` is the storage contract's
  // "has this been written" signal, not a fallback for a failed read.
  const prior = (await storage.exists(ACTIVITY_FILE))
    ? await storage.readText(ACTIVITY_FILE)
    : "";
  await storage.write(ACTIVITY_FILE, prior + line);
}

/**
 * Read events back, newest entries last (file order). When `sinceIso` is given,
 * only events with `ts >= sinceIso` are returned. Malformed lines are skipped
 * — the log is internal but a partially-flushed final line must not abort a
 * report.
 */
export async function readActivity(
  storage: ActivityStorage,
  sinceIso?: string,
): Promise<ActivityEvent[]> {
  if (!(await storage.exists(ACTIVITY_FILE))) return [];
  const text = await storage.readText(ACTIVITY_FILE);
  const sinceMs = sinceIso !== undefined ? Date.parse(sinceIso) : undefined;
  const events: ActivityEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: ActivityEvent;
    try {
      parsed = JSON.parse(trimmed) as ActivityEvent;
    } catch {
      continue;
    }
    if (sinceMs !== undefined && Date.parse(parsed.ts) < sinceMs) continue;
    events.push(parsed);
  }
  return events;
}
