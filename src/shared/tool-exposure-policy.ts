/**
 * Tool-Exposure Policy — single source of truth for *how many* eligible tools
 * a turn may carry before the host switches from eager full-schema exposure to
 * per-tool deferral (compact catalog + `tool_search` discovery).
 *
 * Background (issue #1176): tool-level deferral was made unconditional in
 * `d4d6fa8d`. That withheld every active plugin's tool schema behind per-tool
 * `tool_search` discovery, turning a ~6-round indexer turn into ~21 rounds and
 * blowing the 200K TPM ceiling. The earlier premise that whole-plugin schema
 * loading is itself the TPM failure mode was reversed by measured data: the
 * per-tool discovery tax is the actual cost. Eager exposure is restored for
 * the common case and deferral is reserved for genuinely large tool surfaces.
 *
 * Eligibility note: only *active-plugin* and *in-scope MCP* tools count toward
 * this ceiling. Builtins/meta-tools are always exposed eagerly and are never
 * counted — they are never deferred.
 */

/**
 * Maximum number of eligible (active-plugin + in-scope MCP) tools a turn may
 * expose eagerly. At or above this count the turn falls back to deferral so a
 * very large tool surface does not flood every round's context. Below it, the
 * full tool schemas are exposed directly (no `tool_search` round trips).
 */
export const EAGER_TOOL_EXPOSURE_CEILING = 200;

/**
 * Maximum estimated token cost of the eager plugin/MCP tool-schema payload
 * before a turn falls back to deferral. The MCP "Tools Tax" is a *token* cost
 * (eager schema injection re-paid on every round), so a few very large schemas
 * can threaten TPM while their count stays well under
 * `EAGER_TOOL_EXPOSURE_CEILING`. This budget catches that case; the count
 * ceiling remains a cheap hard upper bound.
 *
 * Calibrated to sit far above the current common surface (the largest single
 * plugin today ≈ 43 tools ≈ ~13k schema tokens; several active plugins ≈
 * 30–40k) so it never re-triggers the #1176 discovery-tax regression, while
 * still
 * tripping for genuinely TPM-threatening payloads (≈200 average schemas, or
 * fewer large ones). Measured with `estimateTokens(JSON.stringify({ tools }))`
 * over the eligible active-plugin + in-scope MCP schemas — the same payload the
 * request-input projection records.
 */
export const EAGER_TOOL_EXPOSURE_TOKEN_BUDGET = 48000;
