// Token + cost number formatting — single authority for every surface that
// renders a token count or a USD amount to the user.

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

/**
 * Format a token count in full, with the runtime locale's digit grouping
 * (`1,234,567`) — the tooltip and dashboard form of {@link formatTokens}.
 *
 * Same clamp as the compact form: a missing, negative or non-finite count
 * renders `"0"`. Two surfaces already clamped their own `Intl.NumberFormat`
 * copies while thirteen others called `.toLocaleString()` on the raw number,
 * so the same aggregate could read `-50` in one badge and `0` in the next.
 */
export function formatTokensExact(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

/**
 * Format a USD amount for display (`$0`, `$0.00050`, `$0.0050`, `$0.050`,
 * `$1.50`).
 *
 * Single authority: four surfaces used to answer "how do I print a dollar
 * amount" differently — the usage dashboard (2 decimals at and above a cent),
 * the per-turn token/cost badge (3 decimals below a dollar), the starred-session
 * list (`Intl.NumberFormat` currency, so locale-dependent), and the pre-flight
 * cost estimate badge. The same $0.50 turn rendered `$0.50`, `$0.500` and
 * `$0.5` depending on which screen the user was looking at.
 *
 * The ladder below is the finest of the four, taken from the per-turn badge:
 * it is a strict refinement, so unifying never drops a digit the user could
 * previously see. Precision widens as the amount shrinks because per-turn and
 * per-session costs cluster well below a cent, where two decimals collapse
 * every distinct value to `$0.00`.
 *
 * Non-positive and non-finite amounts collapse to `"$0"` — a negative amount is
 * not meaningful here and previously rendered as `$-0.5000`.
 *
 * Amounts of $1,000 and over carry thousand separators. The starred-session
 * list already grouped (via `Intl`) and must not lose it; the other three
 * gain it. Dropping the separator would have been the one change in this
 * consolidation that made a number HARDER to read, where every other one
 * converges on a finer or more correct rendering.
 *
 * Callers that need a prefix or a qualifier (`~` for an estimate, an
 * unknown-pricing message) compose it around this function rather than
 * re-deriving the digits; see `cost-estimator.ts:formatCostBadge`.
 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.001) return `$${n.toFixed(5)}`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
