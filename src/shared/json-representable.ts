/**
 * What a JSON wire can carry, and how the escape hatch is sized when it cannot.
 *
 * {@link describeNonJson} answers the first half. {@link base64DecodedLength}
 * answers the second: base64 is what every caller reaches for once the
 * predicate says "these are bytes", and a base64 payload's decoded size has to
 * be known BEFORE it is decoded, or the cap is enforced after the memory it was
 * meant to bound is already allocated. Its two callers — the MCP app download
 * parser and the plugin process boundary — share one implementation here,
 * because a padding rule that drifts between copies is a size cap that means
 * two different things in two places.
 *
 * ── Whether a value survives a JSON round-trip UNCHANGED.
 *
 * Not the same question as "does `JSON.stringify` throw". `Date` and `URL`
 * stringify without complaint and come back as strings; `Buffer` carries a
 * `toJSON()` and comes back as `{ type: "Buffer", data: number[] }`. Each of
 * those is a SUCCESSFUL round-trip into a different type, which is worse than
 * an exception: an exception is noticed, a silent type change passes every
 * test and misbehaves in the field.
 *
 * The prototype check is the load-bearing part. Anything whose prototype is not
 * `Object.prototype` / `Array.prototype` / `null` either vanishes or returns as
 * something else, whatever `JSON.stringify` has to say about it.
 *
 * Promoted from the hostApi marshalling conformance test, which needed exactly
 * this question answered and is still one of its callers.
 */
/**
 * Report the first reason `value` would not survive a JSON round-trip, or
 * `null` when it would.
 *
 * `undefined` is accepted as a PROPERTY value and at the top level: it is how
 * the declared `T | undefined` contracts say "absent", and absent maps onto an
 * omitted field on the wire. Inside an ARRAY it is refused — there it does not
 * mean absent, it becomes `null`, so the array keeps its length while one
 * element silently changes value. A consumer reading that `null` as data is
 * wrong in a way no exception announces. Everything else
 * that JSON cannot carry — functions, symbols, bigints, cycles — and everything
 * whose prototype is not `Object.prototype`/`Array.prototype`/`null` is
 * rejected. The prototype check is the load-bearing one: `Date`, `Map`, `Set`,
 * `URL`, `Uint8Array`, `Response`, and any class instance all either vanish or
 * come back as a different type, and several of them (`Date`, `URL`) stringify
 * without complaint, so `JSON.stringify` alone would not catch them.
 */
export function describeNonJson(
  value: unknown,
  path: string,
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return null;
  if (type === "number") {
    return Number.isFinite(value as number)
      ? null
      : `${path}: non-finite number (JSON.stringify emits null)`;
  }
  if (type !== "object") return `${path}: ${type}`;

  const object = value as object;
  if (seen.has(object)) return `${path}: cycle`;
  seen.add(object);

  const proto = Object.getPrototypeOf(object) as object | null;
  if (Array.isArray(object)) {
    for (const [index, item] of (object as unknown[]).entries()) {
      if (item === undefined) {
        return `${path}[${index}]: undefined in an array (JSON.stringify emits null)`;
      }
      const reason = describeNonJson(item, `${path}[${index}]`, seen);
      if (reason) return reason;
    }
    return null;
  }
  if (proto !== Object.prototype && proto !== null) {
    const name = (object.constructor as { name?: string } | undefined)?.name;
    return `${path}: ${name ?? "non-plain object"}`;
  }
  for (const [key, item] of Object.entries(object)) {
    const reason = describeNonJson(item, `${path}.${key}`, seen);
    if (reason) return reason;
  }
  return null;
}

/**
 * Decoded size of a base64 payload, computed from the ENCODED string.
 *
 * The point is to bound a payload before `Buffer.from(…, "base64")` allocates
 * it. It is an upper bound rather than an exact answer, because that decode is
 * LENIENT — it silently drops characters outside the base64 alphabet — so a
 * caller enforcing a cap must re-check the decoded length afterwards rather
 * than trusting this number alone.
 */
export function base64DecodedLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}
