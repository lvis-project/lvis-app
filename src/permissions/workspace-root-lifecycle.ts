/**
 * The workspace-root (permission-directory) lifecycle: the mutation lock, the
 * host-owned lifecycle holder, and the revocation predicate — one mechanism,
 * one module. Split across three files, each one's doc comment could only
 * explain itself by describing the sweep the other two implement, and
 * `ipc/domains/workspace.ts` had to import two of them side by side to run a
 * single add-or-remove.
 */
import type { PermissionDirectoryLifecycle } from "./permission-slash.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";
import { projectRootEquals } from "../shared/project-identity.js";

let workspaceLifecycleTail: Promise<void> | null = null;

/**
 * Serialize the persisted root mutation and every live/persistent side effect
 * for the workspace registry. Settings file locking alone is not enough: a
 * slow detach could otherwise overtake a later re-add and leave the registry
 * and the live tombstones in opposite states.
 *
 * This queue is intentionally global instead of keyed by an exact root. Parent
 * removal and independently registered child addition overlap semantically even
 * though their canonical strings differ; serializing all rare registry edits
 * closes that snapshot race without affecting normal conversation/tool turns.
 */
export async function withWorkspaceRootLifecycleLock<T>(
  _root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = workspaceLifecycleTail ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceLifecycleTail = tail;

  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceLifecycleTail === tail) workspaceLifecycleTail = null;
  }
}

/**
 * The single authority for the host's workspace-root lifecycle — the object
 * that backs every durable "allow-always" directory approval and every
 * persistent `/permission dir allow|deny`.
 *
 * There is exactly one such object per app run. It is built inside the
 * workspace IPC domain (`ipc/domains/workspace.ts`), because only that module
 * owns the registry/grant/routine sweep a persistent allow or deny must run,
 * and it is published here so every consumer resolves the SAME instance.
 *
 * Why a module holder rather than a dependency field: the lifecycle is created
 * during IPC registration, which happens AFTER the conversation loops, the
 * sub-agent runner and the plugin-surface executor are constructed. Handing it
 * out by value therefore required a hand-written assignment per holder, and
 * every holder that nobody remembered to assign (sub-agent child loops, routine
 * loops) silently degraded to `undefined` — the user was offered "allow-always"
 * in the approval dock and then got `workspace lifecycle unavailable`. Consumers read
 * through `getWorkspaceRootLifecycle` at approval time, so a consumer created
 * before the producer resolves correctly without any wiring of its own.
 *
 * Unset (before IPC registration, or in a standalone executor) resolves to
 * `undefined`, which every consumer treats as fail-closed: the durable write is
 * refused rather than falling back to a settings-only persist.
 */
let workspaceRootLifecycle: PermissionDirectoryLifecycle | undefined;

/**
 * Publish the host-owned lifecycle. Called once, from the workspace IPC domain
 * registrar. Passing `undefined` clears it (test teardown).
 */
export function setWorkspaceRootLifecycle(
  lifecycle: PermissionDirectoryLifecycle | undefined,
): void {
  workspaceRootLifecycle = lifecycle;
}

/**
 * Resolve the lifecycle at use time. `undefined` means "not wired yet" and MUST
 * be treated as fail-closed by the caller.
 */
export function getWorkspaceRootLifecycle(): PermissionDirectoryLifecycle | undefined {
  return workspaceRootLifecycle;
}

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
 *
 * `preserveRoots` entries that are not strictly below `removedRoot` are
 * ignored — a sibling root cannot preserve anything under the root being
 * removed.
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
