/**
 * Canonical calendar keys for usage and Insights surfaces. Usage is reported
 * on Korea Standard Time (UTC+09:00) civil days, independently of the host
 * machine's locale.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

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

/** KST-local week starts on Monday. */
export function kstWeekStartKey(date: Date): string {
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