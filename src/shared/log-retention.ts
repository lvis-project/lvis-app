/**
 * Production-log retention SOT (#1499 E2 / cluster-review architect MAJOR).
 *
 * The retention window for `~/.lvis/logs/` was previously duplicated as two
 * independent literals — `LOG_RETENTION_DAYS` in `log-file-sink.ts` and
 * `DEFAULT_SETTINGS.diagnostics.logRetentionDays` in `settings-store.ts` — plus
 * the clamp bounds lived only in the settings-store normalizer. A drift between
 * them would silently change how far back the boot-time prune reaches versus
 * what the UI reports.
 *
 * This module is the SINGLE source of truth for the default window AND the
 * accepted range. It is deliberately fs-free (no `node:fs`) so the settings
 * store can import it without pulling the sonic-boom / node:fs-bearing sink
 * module into its dependency graph.
 */

/** Default retention window (days) for `~/.lvis/logs/` files. */
export const LOG_RETENTION_DAYS = 7;

/** Inclusive lower bound for a user-configured retention window (days). */
export const LOG_RETENTION_MIN_DAYS = 1;

/** Inclusive upper bound for a user-configured retention window (days). */
export const LOG_RETENTION_MAX_DAYS = 365;

/**
 * Clamp an arbitrary numeric retention value to `[LOG_RETENTION_MIN_DAYS,
 * LOG_RETENTION_MAX_DAYS]`. A non-integer / non-finite input falls back to the
 * default so an out-of-range or malformed value can never persist or drive a
 * prune with a nonsensical window.
 */
export function clampLogRetentionDays(value: number): number {
  if (!Number.isInteger(value)) return LOG_RETENTION_DAYS;
  return Math.min(LOG_RETENTION_MAX_DAYS, Math.max(LOG_RETENTION_MIN_DAYS, value));
}
