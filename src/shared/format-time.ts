/**
 * Time formatting helpers — single source of truth for the time strings the
 * app shows. Every time label goes through one of these, so all surfaces agree
 * on which zone an instant is rendered in.
 *
 * In `shared/` rather than under the renderer because main formats times too —
 * the `/sessions` command lists them — and a copy on that side is exactly how
 * the split this module exists to close would grow back.
 *
 * That zone is the HOST's: `Intl` gets `undefined` for the locale and no
 * `timeZone` option. The chat labels used to pin `ko-KR`/`Asia/Seoul` while the
 * settings tabs already read the host zone, so the same instant could show two
 * different hours one screen apart, and a user outside Korea saw a clock that
 * was not theirs anywhere in the transcript.
 */

/**
 * Clock time for a chat entry: `13:26`, in the host's zone and locale.
 *
 * Accepts epoch milliseconds or an ISO string for the same reason
 * `formatMediumDateTime` does — the live stream entries carry numbers, the
 * stored session records carry ISO strings.
 */
export function formatHhMm(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Date plus clock time for a one-off moment a person has to reason about — a
 * grant expiry, a pairing timestamp. `Jan 2, 2026, 1:26 PM` in the host's zone
 * and locale.
 *
 * Accepts epoch milliseconds or an ISO string because callers hold both: the
 * IPC status payloads carry numbers, the stored starred records carry ISO
 * strings.
 */
export function formatMediumDateTime(value: number | string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/**
 * The words a relative-time label is built from, supplied by the caller so
 * the translation keys stay with the surface that owns them (three surfaces,
 * three key namespaces). `secondsAgo` is optional: a surface without a
 * sub-minute label says "just now" for the first minute.
 */
export interface RelativeTimeLabels {
  readonly justNow: () => string;
  readonly secondsAgo?: (count: number) => string;
  readonly minutesAgo: (count: number) => string;
  readonly hoursAgo: (count: number) => string;
  readonly daysAgo: (count: number) => string;
}

/**
 * "3m ago"-style label for an instant, relative to now. One bucket rule for
 * every surface: seconds under a minute, minutes under an hour, hours under
 * a day, else days, all floored. An unparseable instant renders as an empty
 * label rather than "NaN days ago"; an instant in the future (clock skew
 * between the host and whoever wrote the record) clamps to "just now".
 */
export function formatRelativeTime(value: number | string, labels: RelativeTimeLabels): string {
  try {
    const instant = new Date(value).getTime();
    if (!Number.isFinite(instant)) return "";
    const elapsedMs = Date.now() - instant;
    if (elapsedMs < 0) return labels.justNow();
    const seconds = Math.floor(elapsedMs / 1000);
    if (seconds < 60) return labels.secondsAgo ? labels.secondsAgo(seconds) : labels.justNow();
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return labels.minutesAgo(minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return labels.hoursAgo(hours);
    return labels.daysAgo(Math.floor(hours / 24));
  } catch {
    return "";
  }
}

/** The host's IANA time zone, the zone every label above renders in. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The instant as a local ISO-8601 string with its numeric offset —
 * `2026-01-02T13:26:05+09:00`. For the model's environment block: the
 * offset is computed from the same instant rather than named, so the string
 * stays self-describing across DST, and a model reading it can turn
 * "tomorrow 9am" into the user's 9am.
 */
export function formatLocalIsoWithOffset(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${offsetSign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

/**
 * Clock time with seconds in the host's default locale format —
 * `1:26:05 PM`. The settings tabs' "last synced / last call" style; a
 * distinct style from {@link formatHhMm}, not a second spelling of it.
 */
export function formatClockTime(value: number | string): string {
  return new Date(value).toLocaleTimeString();
}

/**
 * Date and clock time in the host's default locale format —
 * `1/2/2026, 1:26:05 PM`. The settings tables' "connected at / approved at"
 * style; distinct from {@link formatMediumDateTime}'s medium/short style.
 */
export function formatDateTime(value: number | string): string {
  return new Date(value).toLocaleString();
}

/** `January 2026` in the given locale — the usage calendar's month heading. */
export function formatMonthYear(value: number | string | Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(value));
}
