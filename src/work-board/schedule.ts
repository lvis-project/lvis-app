/**
 * Pure helpers for the weekly report cron tick. Unit-tested in isolation; no
 * storage, no side effects.
 */

export interface WeeklyCronConfig {
  dayOfWeek: number; // 0=Sun..6=Sat (Date.getDay() semantics)
  hour: number;
  minute: number;
  tz: string; // "Asia/Seoul" — only Asia/Seoul is supported in MVP
}

const KST_OFFSET_MIN = 9 * 60;

function toKstParts(now: Date): { dayOfWeek: number; hour: number; minute: number } {
  // Asia/Seoul is fixed +09:00 (no DST). Convert via UTC offset.
  const utcMs = now.getTime();
  const kst = new Date(utcMs + KST_OFFSET_MIN * 60_000);
  return {
    dayOfWeek: kst.getUTCDay(),
    hour: kst.getUTCHours(),
    minute: kst.getUTCMinutes(),
  };
}

export function shouldFireWeekly(
  now: Date,
  cfg: WeeklyCronConfig,
  lastFiredKey: string | null,
): { fire: boolean; key: string } {
  if (cfg.tz !== "Asia/Seoul") {
    return { fire: false, key: "unsupported-tz" };
  }
  const parts = toKstParts(now);
  const fire =
    parts.dayOfWeek === cfg.dayOfWeek &&
    parts.hour === cfg.hour &&
    parts.minute >= cfg.minute &&
    parts.minute < cfg.minute + 60; // 1-hour window
  const key = `${parts.dayOfWeek}-${parts.hour}-${cfg.tz}`;
  if (!fire) return { fire: false, key };
  if (lastFiredKey === key) return { fire: false, key };
  return { fire: true, key };
}

/**
 * KST week bounds anchored at Sunday 00:00 KST (covers Sun..Sat 7 days).
 * `weekOffset = 0` → this week (the Sunday on/before today).
 * `weekOffset = -1` → previous week. `weekOffset = +1` → next week (so the
 * sidebar rolls over to the new week the moment Sunday KST hits 00:00).
 */
export function sundayWeekBoundsKst(
  now: Date,
  weekOffset = 0,
): { start: Date; end: Date } {
  const kstNow = new Date(now.getTime() + KST_OFFSET_MIN * 60_000);
  const sundayKstMidnight = Date.UTC(
    kstNow.getUTCFullYear(),
    kstNow.getUTCMonth(),
    kstNow.getUTCDate() - kstNow.getUTCDay() + weekOffset * 7,
  );
  const start = new Date(sundayKstMidnight - KST_OFFSET_MIN * 60_000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60_000);
  return { start, end };
}

export function isoWeekFor(now: Date): string {
  const kst = new Date(now.getTime() + KST_OFFSET_MIN * 60_000);
  const d = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
