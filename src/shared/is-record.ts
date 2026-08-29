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

/**
 * The prototype-strict sibling of {@link isRecord}: a keyed object whose
 * prototype is `Object.prototype` or `null` — what `JSON.parse` produces and
 * nothing else. Use it where the input is a wire or on-disk payload that must
 * be exactly plain data (a bridge request body, a persisted config document);
 * a class instance arriving there came by a route the caller does not model
 * and is refused rather than read. Kept beside the loose guard so the two
 * meanings stay visibly distinct instead of drifting apart in separate copies.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
