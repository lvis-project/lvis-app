/**
 * Time formatting helpers — single source of truth for time strings shown
 * inside the chat UI. All callers MUST go through these helpers so the
 * timezone, locale, and 2-digit padding stay consistent across surfaces.
 *
 * Why centralized: older chat time surfaces inlined `toLocaleTimeString`
 * with different `timeZone` options. A user traveling outside KST saw two
 * different hour values for the same message. (Critic R2 / Code-reviewer R2.)
 */

/**
 * Render an epoch-ms timestamp as `HH:MM` in Korea Standard Time, using
 * ko-KR locale's am/pm prefix (오전/오후). Pads single-digit hour/minute.
 * Returns null when `epochMs` is undefined so callers can omit the entire
 * span rather than rendering a placeholder.
 */
export function formatHhMmKst(epochMs: number | undefined): string | null {
  if (epochMs === undefined) return null;
  return new Date(epochMs).toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
  });
}
