// Token + cost number formatting for the renderer's usage surfaces.

/**
 * Format a token count compactly (`42`, `1.2k`, `47.3M`).
 *
 * Single authority: `UsageDashboard` and `TokenCostBadge` both render token
 * counts and used to abbreviate them with their own private copies, which
 * disagreed on decimals (`1.20M` vs `1.2M`) and — because neither screened its
 * input — rendered `"InfinityM"`, `"NaN"` and `"-50"` straight to the user.
 *
 * The rules below come from the guarded copy that used to live (unimported) in
 * `lib/turn-summary-format.ts`: non-finite and non-positive counts collapse to
 * `"0"` rather than leaking a raw JS number into the UI, and sub-1k counts are
 * rounded so a fractional estimate never renders as `42.7` tokens.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
