/**
 * The single predicate for "does removing workspace root R revoke directory D".
 *
 * Every live-scope owner that `ipc/domains/workspace.ts` sweeps on a workspace
 * root removal — the conversation loops, the routine engine, the sub-agent
 * runner, and the plugin-surface permission scope — must answer this question
 * the same way, or a removed root survives on whichever owner is more lenient.
 *
 * The rule: a directory is revoked when it is at or below the removed root,
 * UNLESS it is at or below a root that was independently registered and is
 * being preserved. Comparison is canonical + case-folded, so `C:\Foo\bar` and
 * `c:/foo/bar` are the same path.
 */
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";
import { projectRootEquals } from "../shared/project-identity.js";

function isPathAtOrBelow(root: string, candidate: string): boolean {
  try {
    const canonicalRoot = caseFoldForMatch(canonicalizePathForMatch(root));
    const canonicalCandidate = caseFoldForMatch(canonicalizePathForMatch(candidate));
    if (!canonicalRoot || !canonicalCandidate) return false;
    return canonicalCandidate === canonicalRoot
      || canonicalCandidate.startsWith(`${canonicalRoot}/`);
  } catch {
    return projectRootEquals(root, candidate);
  }
}

/**
 * Build the revocation test for one removal. `preserveRoots` entries that are
 * not strictly below `removedRoot` are ignored — a sibling root cannot preserve
 * anything under the root being removed.
 */
export function createWorkspaceRootRevocationFilter(
  removedRoot: string,
  preserveRoots: readonly string[] = [],
): (directory: string) => boolean {
  const preserved = preserveRoots.filter(
    (preserveRoot) =>
      !projectRootEquals(removedRoot, preserveRoot)
      && isPathAtOrBelow(removedRoot, preserveRoot),
  );
  return (directory: string): boolean =>
    isPathAtOrBelow(removedRoot, directory)
    && !preserved.some((preserveRoot) => isPathAtOrBelow(preserveRoot, directory));
}
