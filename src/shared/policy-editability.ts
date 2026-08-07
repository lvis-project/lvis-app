/**
 * Single authority for "is the explicit-approval policy user-editable?".
 *
 * A zero-import pure module (same pattern as `shared/theme-bundles.ts` and
 * `shared/appearance-font.ts`) so the main process, the IPC layer and renderer
 * tests can all ask the question without pulling `node:fs` or the policy store
 * into a browser bundle.
 *
 * It mirrors `savePolicy`'s blocking conditions one-for-one:
 *   1. an admin-dir policy file exists → not editable (`source` is "admin" or
 *      "merged" exactly when `loadPolicy` found one)
 *   2. the user file says `managed: true` → not editable
 *
 * Read sites used to answer with the `managed` flag alone, which drops
 * condition 1: an admin-dir policy that does not itself set `managed: true`
 * loads back as `managed: false`, so the Permissions tab offered an editable
 * checkbox for a policy `savePolicy` always rejects. The agreement test in
 * `src/permissions/__tests__/policy-store.test.ts` runs both real functions
 * over the full file matrix and requires
 * `savePolicy rejects  <=>  !isPolicyUserEditable(loadPolicy(...))`.
 */

/** Where the effective policy came from. Mirrored by `LoadedPolicy["source"]`. */
export type PolicySource = "defaults" | "user" | "admin" | "merged";

export function isPolicyUserEditable(policy: {
  source: PolicySource;
  managed?: boolean;
}): boolean {
  if (policy.source === "admin" || policy.source === "merged") return false;
  return policy.managed !== true;
}
