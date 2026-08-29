/**
 * Narrow `unknown` to a keyed object, rejecting `null` and arrays.
 *
 * Arrays are `typeof === "object"` in JS, so a guard that only checks
 * `typeof value === "object" && value !== null` admits them. Callers asking
 * "is this a record" want a keyed object and must not treat an array as one, or
 * a JSON array (common in LLM/provider response bodies) slips into a
 * record-only branch. This is the single home for that guard: every caller
 * imports it so one input cannot be a record to one call site and not to
 * another.
 *
 * This intentionally does NOT add a prototype check: class instances (e.g. the
 * AI SDK's `APICallError`, a plain `Error`) must still count as records, because
 * error-diagnostics callers read `.statusCode` / `.message` off them.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
