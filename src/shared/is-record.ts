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
 * Whether `value` has exactly the own enumerable string keys in `expected`
 * (order-insensitive). The shape check every on-disk record parser runs
 * before trusting field types: an extra key is as much a rejection as a
 * missing one, because a stored document with a field this build does not
 * know is a document another build wrote.
 */
export function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/**
 * Whether every own enumerable string key of `value` is in `allowed`. The
 * looser shape check for inputs where fields are optional: unknown keys are
 * rejected, missing ones are for the caller to judge.
 */
export function hasOnlyKeys(value: object, allowed: ReadonlySet<string> | readonly string[]): boolean {
  const permitted = allowed instanceof Set ? allowed : new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

/**
 * Whether `value` is an array whose every element is a string. `every`
 * skips holes, so a sparse array passes; the inputs this guards are parsed
 * JSON and IPC payloads, which cannot carry holes.
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
