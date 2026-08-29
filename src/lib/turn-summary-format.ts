/**
 * Display formatting for the quantities a turn summary renders — wall-clock
 * duration and byte size. Single authority for both: these labels appear side
 * by side across the transcript, the plugin tabs and the status bar, so the
 * rounding rules have to be one decision, not one per call site.
 *
 * ── Duration ──
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

/**
 * Format a byte count into a compact label.
 *
 * Rules:
 *   - <1 KB  → `840 B`     (a raw count is more useful than `0.8 KB`)
 *   - <1 MB  → `12.4 KB`
 *   - <1 GB  → `3.1 MB`
 *   - ≥1 GB  → `1.2 GB`
 *
 * One decimal above the byte tier throughout: the four copies this replaced
 * disagreed (`Math.round(b/1024) KB` vs `toFixed(0) KB` vs `toFixed(1) KB`,
 * and two of them printed `0.5 KB` for half a kilobyte while a third printed
 * `512 B`), so the same download could show two different sizes in the plugin
 * tab and the status-bar toast.
 *
 * Uses binary units (1 KB = 1024 B), matching every copy it replaced.
 * Negative or non-finite inputs collapse to `0 B`; the function never throws.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}
