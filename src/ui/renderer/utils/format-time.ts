/**
 * Time formatting helpers — single source of truth for the time strings the
 * app shows. Every chat time label goes through one of these, so all surfaces
 * agree on which zone an instant is rendered in.
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
