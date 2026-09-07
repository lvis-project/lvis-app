/**
 * Host-owned ceiling for one-shot/background LLM output.
 *
 * This bounds internal callers such as memory consolidation and reports, and
 * the plugin `generateText` surface behind them. Keep it below a single large
 * model response so a faulty plugin cannot request unbounded work.
 *
 * It applies to those callers ONLY. It is not a transport-wide ceiling: the
 * foreground chat ceiling comes from the user's own vendor settings and is
 * deliberately unclamped — see {@link normalizeOutputTokenLimit}.
 */
export const MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT = 16_384;

/**
 * Returns a provider-safe output limit, or undefined when a caller did not
 * request a valid positive integer cap. Every transport uses this before
 * constructing a request.
 *
 * Shape only — no ceiling. The transport cannot tell a background call from a
 * foreground one, so a ceiling here governs both, and it used to: a user who
 * set a chat ceiling of 32,768 silently got 16,384, a number chosen for
 * plugins. Clamping a value the user configured is the same failure as guessing
 * a per-model ceiling, which the host declines to do — the provider rejects a
 * limit its model cannot serve, and that error names the real bound. Callers
 * that DO own a ceiling apply it before they reach here; see
 * {@link clampBackgroundOutputTokenLimit}.
 */
export function normalizeOutputTokenLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

/**
 * The same shape check plus {@link MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT}, for the
 * background/plugin callers that number belongs to. A plugin asking for more
 * than the host is willing to spend on its behalf is capped rather than
 * refused: the work still completes, bounded.
 */
export function clampBackgroundOutputTokenLimit(
  value: number | undefined,
): number | undefined {
  const normalized = normalizeOutputTokenLimit(value);
  return normalized === undefined
    ? undefined
    : Math.min(normalized, MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT);
}
