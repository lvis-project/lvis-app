import { resolve as pathResolve } from "node:path";
import { expandLeadingTilde } from "./home-tilde.js";

/**
 * Single source of truth for turning a tool-call path ARGUMENT into an
 * absolute path for permission purposes.
 *
 * WHY THIS LIVES IN `shared/` AND NOT NEXT TO EITHER CALLER
 * ---------------------------------------------------------
 * Two layers resolve the same argument and must agree:
 *
 *  - the ENFORCER — `tools/pipeline/path-extraction.extractTargetFilePaths`,
 *    whose output feeds the Layer-0 sensitive-path hard block and the Layer-1
 *    allowed-directory check;
 *  - the REVIEWER — `permissions/reviewer/risk-classifier.extractDeclaredPaths`,
 *    whose output feeds the Layer-5 verdict that drives auto-approval routing
 *    and the approval-memory escalation guard.
 *
 * `permissions/` cannot import `tools/pipeline/` (the pipeline imports
 * `permissions/`; `check:import-cycles` is the arbiter), so the shared
 * resolver has to be a leaf both sides can reach. `shared/home-tilde.ts`,
 * which already owns the `~` half of this problem, is that leaf.
 *
 * The divergence this closes: the reviewer used a bare `path.resolve(value)`,
 * so `~` survived as a literal directory segment and a relative argument
 * resolved against `process.cwd()` instead of the INVOCATION cwd. A write of
 * `~/secret.txt` looked like `<process.cwd()>/~/secret.txt` to the reviewer
 * (LOW — "write at allowed-dir leaf" whenever the project root is allowed)
 * while Layer 1 checked `<home>/secret.txt` (HIGH — outside allowed dirs).
 *
 * NOT the canonical-match form: callers that prefix-compare against allowed
 * directories still run this output through `canonicalizePathForMatch` +
 * `caseFoldForMatch`.
 */
export function resolveToolPathForPermission(value: string, cwd: string): string {
  // Tilde expansion is delegated to `shared/home-tilde.ts` — the SAME function
  // the tool side calls (`file-read-core.assertReadableFilePath`,
  // `FileTool.resolvePath`, `FileTool.resolveApprovalPath`). If this diverges
  // again, the permission layer judges a file the tool never opens.
  return pathResolve(pathResolve(cwd), expandLeadingTilde(value));
}
