/**
 * Narrow `unknown` to a keyed object, rejecting `null` and arrays.
 *
 * Arrays are `typeof === "object"` in JS, so a guard that only checks
 * `typeof value === "object" && value !== null` admits them. Callers asking
 * "is this a record" want a keyed object and must not treat an array as one —
 * otherwise the same input is a record to one guard and not-a-record to the ~38
 * sibling copies that already exclude arrays, and a JSON array (common in
 * LLM/provider response bodies) slips into a record-only branch.
 *
 * This intentionally does NOT add a prototype check: class instances (e.g. the
 * AI SDK's `APICallError`, a plain `Error`) must still count as records, because
 * error-diagnostics callers read `.statusCode` / `.message` off them.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
