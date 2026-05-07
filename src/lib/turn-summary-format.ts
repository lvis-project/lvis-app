/**
 * Turn summary footer — display formatters.
 *
 * Used by `TurnSummaryFooter` to render the aggregate one-line footer
 * appended to a completed chat turn. Companion to per-tool duration
 * formatting on `ToolGroupCard`; both stay in sync on rounding rules
 * (sub-second → "<0.1s", minute → "Xm Y.Zs") so the cumulative total
 * never visually contradicts the per-tool slices it sums.
 */

/**
 * Format a wall-clock duration into a compact label.
 *
 * Rules:
 *   - <100ms          → `<0.1s`     (sub-tick noise — implies "instant")
 *   - <60s            → `1.4s`      (one decimal seconds)
 *   - <60min, integer → `1m 12s`    (drop fractional seconds for readability)
 *   - <60min          → `1m 12.4s`  (when fractional component is significant)
 *   - ≥60min          → `1h 03m`    (drop seconds at hour scale)
 *
 * Negative or non-finite inputs collapse to `0s`. The function never
 * throws — caller can pass an optional `cumulativeToolMs` that may be
 * 0 when the per-tool duration PR has not yet been merged.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 100) return "<0.1s";
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    const totalSec = ms / 1000;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec - minutes * 60;
    // Drop the decimal when seconds are effectively integer — produces
    // the cleaner "1m 12s" form expected for whole-second durations.
    if (Math.abs(seconds - Math.round(seconds)) < 0.05) {
      return `${minutes}m ${Math.round(seconds)}s`;
    }
    return `${minutes}m ${seconds.toFixed(1)}s`;
  }
  const totalMin = ms / 60_000;
  const hours = Math.floor(totalMin / 60);
  const minutes = Math.round(totalMin - hours * 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * Format a token count compactly. Mirrors AssistantCard's existing
 * abbreviation rule (1.2k, 47.3k) and extends it to millions.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
