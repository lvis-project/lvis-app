/**
 * KST calendar *bounds* for Work Board reports: the daily report covers one KST
 * day, the weekly report a Sunday-anchored KST week. These helpers project a
 * UTC instant onto those boundaries so report windows match what the user sees
 * on a wall clock, independent of the host's process TZ.
 *
 * The day *key* itself is not computed here — `kstDateKey` in
 * `shared/kst-date.ts` is the one projection, shared with usage and Insights.
 *
 * All functions are pure over an injected instant (no `Date.now()` inside) so
 * report windows are deterministically testable.
 */
import { KST_OFFSET_MS } from "../shared/kst-date.js";

/** UTC instants bounding the given `YYYY-MM-DD` KST day, or null if malformed. */
export function kstDayBounds(day: string): { startMs: number; endMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const startUtcForKstMidnight =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - KST_OFFSET_MS;
  return { startMs: startUtcForKstMidnight, endMs: startUtcForKstMidnight + 24 * 60 * 60_000 };
}

/**
 * Sunday-anchored KST week bounds as UTC `Date`s. `weekOffset` shifts whole
 * weeks (0 = the week containing `now`, -1 = the prior week).
 *
 * Sunday, unlike `kstMondayWeekStartKey` which usage reporting uses — two
 * different weekly reports, not a drift between two copies of one.
 */
export function sundayWeekBoundsKst(
  now: Date,
  weekOffset = 0,
): { start: Date; end: Date } {
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const sundayKstMidnight = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate() - kstNow.getUTCDay() + weekOffset * 7,
  );
  const start = new Date(sundayKstMidnight - KST_OFFSET_MS);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60_000);
  return { start, end };
}

/** ISO-8601 week label (`YYYY-Www`) for the KST projection of an instant. */
export function isoWeekFor(now: Date): string {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const d = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
