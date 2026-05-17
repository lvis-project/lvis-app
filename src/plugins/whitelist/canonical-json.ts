/**
 * #893 Ralph cycle 1 — RFC 8785 JCS-style canonical JSON serializer
 * dedicated to the manifest-sha pin path.
 *
 * Why a second canonical helper (vs `src/shared/canonical-json.ts`)?
 *   - The shared serializer is wired into permission-cache key symmetry
 *     and HMAC nonce signing. We do NOT want the manifest-sha pin to
 *     silently change identity when that helper evolves (e.g. starts
 *     emitting BigInt support) — manifests on disk would then suddenly
 *     re-hash and break Tier-3 grants until re-signed. Pinning the
 *     manifest-sha to this dedicated module isolates the trust domain.
 *   - The previous code used `JSON.stringify(manifest, Object.keys(manifest).sort())`
 *     which is the REPLACER-ARRAY form. It only restricts top-level keys
 *     and emits every nested object as `{}` (verified empirically:
 *     `JSON.stringify({a:0,b:{x:1},c:1},["a","b","c"])` =
 *     `'{"a":0,"b":{},"c":1}'`). The result is that all plugins
 *     hash to the same sha, defeating the Tier-3 pin.
 *
 * Contract (RFC 8785 JSON Canonicalization Scheme, subset):
 *   - Object keys sorted lexicographically at every depth.
 *   - Arrays preserve element order; nested objects in arrays are
 *     recursively canonicalized.
 *   - Primitives delegated to `JSON.stringify` — preserves numeric
 *     handling (`NaN`/`Infinity` → `"null"`), string escaping, and
 *     boolean/null shapes.
 *   - `undefined` values: at top-level → `"null"` (mirrors `JSON.stringify`);
 *     as object properties → key dropped; as array elements → `"null"`
 *     (mirrors `JSON.stringify` array behaviour). Matches `JSON.stringify`
 *     semantics so callers that have always passed JSON-clean manifests
 *     produce the same string as before for trivially-flat inputs.
 *
 * NOT supported (intentionally — manifests are JSON-clean by contract):
 *   - Cycles (will throw RangeError from recursion).
 *   - BigInt (TypeError from JSON.stringify).
 *   - Date / Map / Set (delegated to JSON.stringify defaults).
 */

export function canonicalJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    // Primitive — delegate to JSON.stringify. `NaN`/`Infinity` → `"null"`,
    // strings get proper escaping, booleans/numbers/null pass through.
    const s = JSON.stringify(value);
    return s ?? "null";
  }
  if (Array.isArray(value)) {
    // Arrays preserve element order; recursively canonicalize each entry
    // so nested objects inside arrays still get keys sorted.
    const parts = value.map((e) => canonicalJSON(e));
    return `[${parts.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined) // mirror JSON.stringify object behaviour
    .sort();
  const parts = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}
