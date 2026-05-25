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
