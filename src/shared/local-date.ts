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

/** Add (or subtract) whole days to a `YYYY-MM-DD` key. Malformed keys pass through. */
export function shiftLocalDateKey(key: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return key;
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days),
  );
  return shifted.toISOString().slice(0, 10);
}

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
