/**
 * Canonical civil-calendar keys. Days are the HOST machine's civil days, so a
 * usage row, an Insights bucket and a Work Board report all agree on where one
 * day ends — and agree with the calendar the person reading the screen is
 * looking at.
 *
 * Every projection here goes through `Date`'s local getters rather than an
 * offset added to UTC. That is not a stylistic choice: an offset constant is
 * wrong twice a year in any zone that observes DST, whereas the local getters
 * ask the platform what the civil date actually was at that instant.
 *
 * `shiftLocalDateKey` is the exception and deliberately uses `Date.UTC`: it
 * does arithmetic on a `YYYY-MM-DD` string that is already a civil date, and
 * UTC is the only way to add days to a civil date without a DST-shortened day
 * landing it on the wrong one.
 */

/**
 * Project an instant to the host's civil day `YYYY-MM-DD`.
 *
 * The year is padded to four digits so the key is always the width the rest of
 * the module's regexes expect — these keys are compared with `<`/`>` as strings
 * in the usage range filters, and a short year would sort wrong.
 */
export function localDateKey(date: Date): string {
  return `${padYear(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function padYear(year: number): string {
  return String(year).padStart(4, "0");
}

/**
 * Add (or subtract) whole days to a `YYYY-MM-DD` key. Malformed keys pass
 * through.
 *
 * The month/day are seeded at a placeholder year and the real year is stamped
 * on afterwards, because `Date.UTC` maps a year of 0-99 onto 1900+y exactly as
 * `new Date(y, …)` does — the same trap {@link localDayStart} documents. Left
 * uncorrected, `shiftLocalDateKey("0099-01-01", 1)` returns "1999-01-02" and
 * {@link localDayRange} opens a range nineteen centuries wide instead of one
 * day. The placeholder is a leap year so a Feb 29 key survives the seeding step
 * and only then meets the real year's calendar.
 */
export function shiftLocalDateKey(key: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return key;
  const shifted = new Date(Date.UTC(LEAP_SEED_YEAR, Number(match[2]) - 1, Number(match[3])));
  shifted.setUTCFullYear(Number(match[1]));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Placeholder year for seeding a civil date: in range for `Date.UTC`, and a leap year. */
const LEAP_SEED_YEAR = 2000;

/**
 * Key for the MONDAY that starts the host-civil week containing `date`.
 *
 * Deliberately not the same anchoring as `sundayWeekBoundsLocal` in
 * `work-board/schedule.ts`: usage weeks run Monday-to-Sunday, the Work Board's
 * weekly report runs Sunday-to-Saturday. Both names now say which, so a reader
 * comparing the two numbers can see they are different weeks rather than
 * assuming one of them is wrong.
 */
export function localMondayWeekStartKey(date: Date): string {
  const day = date.getDay();
  const monday = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - (day === 0 ? 6 : day - 1),
  );
  return localDateKey(monday);
}

/**
 * The instant at which the given `YYYY-MM-DD` local civil day begins, or `null`
 * for a malformed key.
 *
 * This is the one place that turns a picked calendar day back into a point in
 * time. The Work Board needs it twice — the panel stamps a due date with it,
 * the report bounds a day with it — and those two must agree, or an item
 * created on the day the report covers falls outside the report.
 */
export function localDayStart(dayKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // `new Date(y, …)` maps a year of 0-99 onto 1900+y, so a key like "0099-01-01"
  // would silently become 1999. `setFullYear` is the documented way out.
  start.setFullYear(Number(match[1]));
  return start;
}

/** Key for the first day of the host-civil month containing `date`. */
export function localMonthStartKey(date: Date): string {
  return `${padYear(date.getFullYear())}-${pad(date.getMonth() + 1)}-01`;
}

/**
 * The UTC calendar day of `instant` as `YYYY-MM-DD`.
 *
 * This is the key for the UTC-partitioned stores — audit rows and log file
 * names — which deliberately do NOT follow the host's civil day, so that a
 * partition never splits or merges when the machine changes zone. It is not a
 * label: anything a person reads goes through {@link localDateKey}.
 */
export function utcDateKey(instant: Date = new Date()): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * The half-open instant range `[start, end)` covered by the inclusive local
 * civil days `[fromKey, toKey]`. Either bound may be left open.
 *
 * `end` is the start of the day AFTER `toKey`, so a timestamp belongs to the
 * range when `start <= t < end` and the last picked day keeps its final
 * second — there is no "last instant of a day" to compare `<=` against once
 * DST can shorten the day. A malformed key yields `null`; callers validated
 * their keys upstream and treat `null` as a contract error.
 */
export function localDayRange(
  fromKey?: string,
  toKey?: string,
): { start?: Date; end?: Date } | null {
  const start = fromKey === undefined ? undefined : localDayStart(fromKey);
  const end = toKey === undefined ? undefined : localDayStart(shiftLocalDateKey(toKey, 1));
  if (start === null || end === null) return null;
  return { start, end };
}
