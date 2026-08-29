/**
 * Time formatting helpers — single source of truth for time strings shown
 * inside the chat UI. All callers MUST go through these helpers so the
 * timezone, locale, and 2-digit padding stay consistent across surfaces.
 *
 * Why centralized: older chat time surfaces inlined `toLocaleTimeString`
 * with different `timeZone` options. A user traveling outside KST saw two
 * different hour values for the same message. (Critic R2 / Code-reviewer R2.)
 */




export function formatHhMmKst(epochMs: number | undefined): string | null {
  if (epochMs === undefined) return null;
  return new Date(epochMs).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
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
