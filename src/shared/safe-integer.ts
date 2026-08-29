/**
 * Integer guards for values that arrive as `unknown` — IPC payloads, stored
 * records, provider telemetry, platform ids.
 *
 * WHY THIS IS ITS OWN MODULE. The same two predicates were declared in four
 * domains (engine, main, shared, renderer) under five names —
 * `isPositiveSafeInteger`, `positiveInteger`, `timestamp`, `epoch`,
 * `counter` — and there is no numeric-guard leaf in `shared/` to host them.
 * They must be a leaf: the renderer's IPC-response policy and the main
 * process's platform adapters both need them, and neither may import the
 * other.
 *
 * Epoch-millisecond timestamps and monotonic counters are not given their
 * own names here on purpose: each was, at every copy, exactly one of these
 * two predicates, and a second name for the same check is how the copies
 * came to exist.
 */

/** A safe integer greater than zero — ids, counts, byte limits, epoch ms of a real instant. */
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A safe integer of zero or more — token counts, counters, epoch ms where zero means "never". */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * {@link isPositiveSafeInteger} as a coercer: returns `value` typed as a
 * number, or throws a `RangeError` carrying `message` — the stable error
 * code or sentence the caller's contract names.
 */
export function requirePositiveInteger(value: number, message: string): number;
export function requirePositiveInteger(value: unknown, message: string): number;
export function requirePositiveInteger(value: unknown, message: string): number {
  if (!isPositiveSafeInteger(value)) throw new RangeError(message);
  return value;
}
