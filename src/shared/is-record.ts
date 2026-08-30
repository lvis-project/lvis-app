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
 * Whether `value` is an array whose every indexed element is a string, with
 * no holes. The check walks `0..length-1` by index, which is what a consumer
 * of a `string[]` does, so it refuses both shapes a looser check admits:
 * a sparse array (`Array.prototype.every` skips holes and `[ , "a"]` would
 * pass, then read back as `undefined`) and an array whose own
 * `Symbol.iterator` yields strings while its indexed elements are not (a
 * spread-then-`every` check sees only the iterator). Parsed JSON and IPC
 * payloads can carry neither, so for them the verdict is the same as a bare
 * `every`; the A2A codec validates in-memory objects, where both differences
 * are real.
 */
export function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return false;
  }
  return true;
}
