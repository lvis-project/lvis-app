/**
 * Wall-clock duration display formatting — single authority.
 *
 * The turn footer (`WorkGroup`) and the per-tool badges on `ToolGroupCard`
 * render the same quantity. They used to do it with two functions
 * (`formatDuration` here and `formatToolDuration` in
 * `ui/renderer/utils/format-duration.ts`) whose header comments each claimed
 * the two "stay in sync on rounding rules" while they disagreed on three:
 * whole seconds at minute scale (`1m 12s` vs `1m 12.0s`), the hour scale
 * (`1h 03m` vs `63m 0.0s`), and zero. A turn footer could therefore read
 * `1h 03m` above tool rows summing to `63m 0.0s`.
 *
 * The richer set of rules won, so nothing rounds more coarsely than before.
 * Callers that must hide the label for a missing or nonsensical duration guard
 * at the call site instead of relying on an empty-string return.
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
 * Negative or non-finite inputs collapse to `0s`; the function never throws.
 * A caller that wants no label at all for those cases (the tool badges hide
 * rather than print `0s`) checks the input itself.
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
