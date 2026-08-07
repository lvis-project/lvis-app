/**
 * Dotted-field selection over a tool's finalized input — the SELECTION half of
 * "which filesystem paths does this tool call touch".
 *
 * A tool declares its path-bearing arguments as `pathFields` (builtins on the
 * `Tool` descriptor; plugin tools via `_meta["lvisai/pathFields"]`). Two
 * consumers read that declaration off the same input object:
 *
 *   • `tools/pipeline/path-extraction.ts` — resolves the selected values to
 *     absolute paths for the ApprovalGate sensitive-path block and Layer-1
 *     scope check;
 *   • `permissions/reviewer/risk-classifier.ts` — canonicalizes the selected
 *     values for its containment rules.
 *
 * Only the SELECTION is shared here. The two consumers deliberately normalize
 * the selected values differently, and this module does not reconcile that —
 * see `permissions/reviewer/__tests__/declared-path-resolution-divergence.test.ts`,
 * which pins the current difference so a change to it has to be deliberate.
 *
 * Kept in `shared/` because neither consumer's layer may depend on the other's.
 */

/**
 * Read `field` (a dot-separated path) out of `input`.
 *
 * Refuses to traverse INTO an array: a segment that lands on an array stops the
 * walk. Callers treat a final array value as a list of candidates, so allowing
 * numeric-index traversal would make `files.0` and `files` disagree about how
 * many paths a call touches. An empty segment (`"a..b"`, `".a"`) is a malformed
 * declaration and yields `undefined` rather than the container object.
 */
export function getDottedFieldValue(
  input: Record<string, unknown>,
  field: string,
): unknown {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (segment.length === 0) return undefined;
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
