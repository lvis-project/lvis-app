/**
 * Host-owned ceiling for one-shot/background LLM output.
 *
 * This bounds internal callers such as memory consolidation and reports; it is
 * intentionally separate from user-facing sampling controls. Keep it below a
 * single large model response so a faulty plugin cannot request unbounded work.
 */
export const MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT = 16_384;

/**
 * Returns a provider-safe output limit, or undefined when a caller did not
 * request a valid positive integer cap. Every transport uses this before
 * constructing a request.
 */
export function normalizeOutputTokenLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT);
}
