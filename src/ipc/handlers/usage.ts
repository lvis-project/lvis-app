/**
 * usage.ts (handlers) — transport-agnostic PUBLIC usage handler logic (#1409 C10).
 *
 * Pure `handle*` functions behind the PUBLIC usage channels (`usage summary`,
 * `usage range`). They import NOTHING from the electron transport; the
 * `ipcMain.handle` wrapper + sender guard (on `usage range`) stay in
 * `domains/usage.ts`. The engine `usage-stats` module is lazily imported here
 * exactly as before to keep it out of the boot-time graph.
 */

/** PUBLIC `lvis:usage:summary` — rolling usage summary over `days` (default 60). */
export async function handleUsageSummary(days?: number) {
  const { getUsageSummary } = await import("../../engine/usage-stats.js");
  return getUsageSummary(typeof days === "number" ? days : 60);
}

/** PUBLIC `lvis:usage:range` — usage aggregated over an explicit date range. */
export async function handleUsageRange(opts: { dateFrom: string; dateTo: string }) {
  const { getUsageRange } = await import("../../engine/usage-stats.js");
  return getUsageRange(opts);
}
