/**
 * Renderer-side helper for formatting per-tool execution duration in the
 * chat transcript. Output goes into the `⏱ 1.4s` badge on every
 * ToolGroupCard row.
 *
 * Format rules (matches the spec used by ToolGroupCard):
 *   - durationMs < 100   → "<0.1s"   (sub-100ms calls bucketed for noise)
 *   - durationMs < 60000 → "0.3s"    (one decimal place, second precision)
 *   - durationMs ≥ 60000 → "1m 12.4s" (minutes + seconds with one decimal)
 *
 * Used by ToolGroupCard.tsx (single-tool inline + grouped rows).
 */
export function formatToolDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 100) return "<0.1s";
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}
