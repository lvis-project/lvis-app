/**
 * Shared canonical JSON serializer — single SOT for record/lookup key symmetry.
 *
 * Used by:
 *   - src/permissions/user-approval-store.ts (main process)
 *   - src/ui/renderer/components/ToolApprovalDialog.tsx (renderer process)
 *
 * Produces a deterministic JSON string where object keys are sorted so that
 * {a, b} and {b, a} produce identical output. This prevents key-ordering
 * differences from producing distinct entryKey hashes for semantically
 * identical inputs (HIGH-2 JSON canonical fix, R-2 memory layer symmetry).
 *
 * H-1 undefined asymmetry fix (R-5): keys whose value is `undefined` are
 * dropped, matching JSON.stringify behaviour. A top-level `undefined` is
 * serialised as "null" per RFC 8259 (JSON has no undefined token).
 *
 * ## Value-type handling contract (issue #800)
 *
 * Permission tool args originate either from JSON-parsed LLM tool input
 * (always JSON-clean) or from user-typed strings (renderer + IPC). The
 * function delegates non-object primitives + arrays to `JSON.stringify`,
 * so its behaviour for non-JSON-native value types is inherited from
 * there:
 *
 *   - `Array`          → element order is preserved (NOT sorted). Two
 *                        arrays with the same elements in different
 *                        order produce distinct strings. Tool args
 *                        relying on element-order-agnostic comparison
 *                        must normalize (e.g. `[...arr].sort()`) before
 *                        calling. **Nested objects inside arrays ARE
 *                        recursively canonicalized** (keys sorted) per
 *                        RFC 8785 JCS — `[{a:1,b:2}]` and `[{b:2,a:1}]`
 *                        produce identical output. Required for HMAC
 *                        stability when caller uses this for nonce
 *                        signing (issue #828).
 *   - `Date`           → quoted ISO string via `Date.prototype.toJSON`
 *                        (e.g. `"2026-05-16T14:30:00.000Z"`). Two Date
 *                        instances with the same epoch produce identical
 *                        output → key symmetry preserved.
 *   - `BigInt`         → `JSON.stringify` throws `TypeError`. Callers
 *                        upstream must coerce to string/number before
 *                        reaching this function. The record path in
 *                        `user-approval-store.ts` controls inputs, so a
 *                        BigInt arriving here indicates a contract bug.
 *   - `Map` / `Set`    → `JSON.stringify` returns `"{}"`. **Caveat**: two
 *                        Maps/Sets with different contents serialise to
 *                        the same string. If callers need symmetric
 *                        comparison across Maps/Sets, convert to
 *                        `Object.fromEntries(map)` or
 *                        `Array.from(set).sort()` before calling.
 *   - `function`       → `JSON.stringify` returns `undefined` (the
 *                        whole property is dropped at the parent level).
 *                        At the top level the early `value === undefined`
 *                        return maps it to the literal string `"null"`.
 *                        Functions should never reach this layer; if
 *                        they do, the symmetry guarantee no longer
 *                        applies.
 *   - `Symbol`         → same as function (`JSON.stringify` drops keys
 *                        whose value is Symbol, returns `undefined` at
 *                        top level → `"null"` here).
 *   - `NaN` / `±Infinity` → `JSON.stringify` returns `"null"` per spec.
 *                        Two `NaN`s and `±Infinity` collapse to the same
 *                        string — acceptable for our R-2 use case
 *                        (permission cache key) but worth noting.
 *
 * In summary: callers should pass JSON-clean tool args (plain objects,
 * arrays of primitives, strings, numbers, booleans, null). The exotic-
 * type behaviour above is documented so a future reader can understand
 * the symmetry properties of the resulting cache key.
 *
 * Spec ref: docs/research/sandbox-isolation.md §R-2
 * Issue: #691 PR-A4 Round 5, #800 value-type docs
 */
/**
 * Defense-in-depth limits (issue #797).
 *
 * Production inputs (JSON-parsed LLM tool args, user-typed strings) cannot
 * carry cycles or extreme nesting, so these guards are not exploitable
 * today. They protect against future code paths that might call into this
 * function with renderer-constructed objects (React state refs, DOM
 * nodes) where cycles + huge graphs are easier to introduce.
 */
const MAX_DEPTH = 100;

export function canonicalStringify(value: unknown): string {
  return canonicalStringifyInner(value, new WeakSet(), 0);
}

function canonicalStringifyInner(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): string {
  if (depth > MAX_DEPTH) return '"[MaxDepth]"';
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (seen.has(value as object)) return '"[Circular]"';
  seen.add(value as object);
  if (Array.isArray(value)) {
    // RFC 8785 JCS — element order preserved; nested objects within an
    // array are RECURSIVELY canonicalized (keys sorted). Without this,
    // `[{a:1,b:2}]` and `[{b:2,a:1}]` produce distinct strings, breaking
    // R-2 cache symmetry and HMAC stability for approval-gate
    // (issue #828 — private duplicate consolidation).
    const parts = value.map(
      (e) => canonicalStringifyInner(e, seen, depth + 1),
    );
    return `[${parts.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  const parts = sortedKeys.map(
    k => `${JSON.stringify(k)}:${canonicalStringifyInner(obj[k], seen, depth + 1)}`,
  );
  return `{${parts.join(",")}}`;
}
