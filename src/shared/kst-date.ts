/**
 * Canonical civil-calendar keys. Days are Korea Standard Time (UTC+09:00)
 * civil days, independently of the host machine's zone, so a usage row, an
 * Insights bucket and a Work Board report all agree on where one day ends.
 *
 * The offset is exported because `work-board/schedule.ts` needs the same
 * anchor to compute day and week *bounds*; it used to carry its own
 * `KST_OFFSET_MIN` and its own `kstDay`, so the board could disagree with
 * Insights about which day an instant fell in.
 */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Project an instant to the KST civil day `YYYY-MM-DD`. */
export function kstDateKey(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function shiftKstDateKey(key: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return key;
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * Week key for the MONDAY that starts the KST week containing `date`.
 *
 * Deliberately not the same anchoring as `sundayWeekBoundsKst` in
 * `work-board/schedule.ts`: usage weeks run Monday-to-Sunday, the Work Board's
 * weekly report runs Sunday-to-Saturday. Both names now say which, so a reader
 * comparing the two numbers can see they are different weeks rather than
 * assuming one of them is wrong.
 */
export function kstMondayWeekStartKey(date: Date): string {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  const day = shifted.getUTCDay();
  shifted.setUTCDate(shifted.getUTCDate() - (day === 0 ? 6 : day - 1));
  return shifted.toISOString().slice(0, 10);
}

export function kstMonthStartKey(date: Date): string {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
