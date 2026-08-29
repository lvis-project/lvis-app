/**
 * Host-civil calendar *bounds* for Work Board reports: the daily report covers
 * one local day, the weekly report a Sunday-anchored local week. These helpers
 * project an instant onto those boundaries so report windows match the calendar
 * the user is looking at.
 *
 * The day *key* itself is not computed here — `localDateKey` in
 * `shared/local-date.ts` is the one projection, shared with usage and Insights.
 *
 * Bounds are built from `localDayStart` rather than an offset subtracted from
 * UTC, so a DST transition inside the window still yields midnight-to-midnight
 * rather than a 23- or 25-hour day misaligned by an hour — and so the day this
 * report covers is bounded by exactly the instant the panel stamps on a due
 * date for that day.
 *
 * All functions are pure over an injected instant (no `Date.now()` inside) so
 * report windows are deterministically testable.
 */
import { localDayStart, shiftLocalDateKey } from "../shared/local-date.js";

/** Instants bounding the given `YYYY-MM-DD` local day, or null if malformed. */
export function localDayBounds(day: string): { startMs: number; endMs: number } | null {
  const start = localDayStart(day);
  const end = localDayStart(shiftLocalDateKey(day, 1));
  if (start === null || end === null) return null;
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/**
 * Sunday-anchored local week bounds. `weekOffset` shifts whole weeks (0 = the
 * week containing `now`, -1 = the prior week).
 *
 * Sunday, unlike `localMondayWeekStartKey` which usage reporting uses — two
 * different weekly reports, not a drift between two copies of one.
 */
export function sundayWeekBoundsLocal(
  now: Date,
  weekOffset = 0,
): { start: Date; end: Date } {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - now.getDay() + weekOffset * 7,
  );
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { start, end };
}

/** ISO-8601 week label (`YYYY-Www`) for the local civil day of an instant. */
export function isoWeekFor(now: Date): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
