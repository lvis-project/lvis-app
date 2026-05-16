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
 * Spec ref: docs/research/sandbox-isolation.md §R-2
 * Issue: #691 PR-A4 Round 3
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const parts = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}
