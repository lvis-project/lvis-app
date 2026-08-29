/**
 * Filesystem helpers for plugin install dir removal.
 *
 * Extracted from `marketplace.removeInstalledEntry` so the Windows-atomic
 * uninstall semantics (rename → defer rm) can be unit-tested without
 * standing up a full PluginMarketplaceService.
 *
 * ## Edge cases the rename can still fail (rare, host-side surfacing)
 *
 * - **Antivirus / endpoint protection, or an open Windows handle created
 *   without delete sharing**, holding the directory or a child file →
 *   `rename` throws EPERM/EACCES (errno -4048).
 * - **Process holds the install dir as cwd** → rename fails. LVIS host code
 *   does not chdir into plugin dirs (verified — no `process.chdir()` calls
 *   reference plugin paths) so this is only possible if a plugin worker
 *   misuses cwd. Out of scope for this fix; user sees the throw.
 * - **macOS/Linux**: rename is always atomic; `rm` of files with open
 *   handles unlinks the directory entry while the inode persists until
 *   handles close. The whole tombstone-defer pattern is harmless here but
 *   gives uniform code across platforms.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * Subdirectory under `pluginsRoot` where uninstall tombstones live.
 *
 * The `+` separator is intentional — plugin ids must satisfy
 * `^[a-zA-Z0-9._-]+$` (see marketplace.ts:1184), so `+tombstones+` cannot
 * collide with any installed plugin's directory name. This is a structural
 * defense against the "malicious plugin slug ending in `.uninstalling-1`
 * gets swept on boot" attack: tombstones live under their own namespace,
 * never as siblings of plugin dirs, so the sweeper's name match cannot
 * mistake a real plugin for a tombstone.
 */
export const TOMBSTONE_SUBDIR = "+tombstones+";

/**
 * Subdirectory under `pluginsRoot` where state nobody can attribute is PARKED.
 *
 * Deliberately NOT {@link TOMBSTONE_SUBDIR}. That namespace is a REMOVAL
 * lifecycle: `tombstoneAndDeferredRemove` schedules an `rm` of what it renames,
 * and anything that survives that `rm` is finished off by
 * `sweepOrphanUninstallDirs` on the next boot. A caller that wants to KEEP
 * bytes cannot express that by renaming them there — it only chooses whether
 * they are deleted now or at the next boot.
 *
 * Recovery needs to keep them. When two non-empty plugin data directories
 * arrive at one carry, one of them is state no transaction accounts for, and
 * recovery cannot tell which side a human would want. Deleting the loser makes
 * the carry's "never deletes state" rule untrue; leaving it in place wedges the
 * recovery. So it moves here and STAYS here: nothing sweeps this directory, and
 * it exists precisely so an operator can look at what could not be attributed.
 * The `+` separator is the same structural defence tombstones use — plugin ids
 * match `^[a-zA-Z0-9._-]+$`, so this can never collide with a plugin directory
 * or be mistaken for one.
 */
export const PARKED_PLUGIN_STATE_SUBDIR = "+unattributed-plugin-state+";

const RECURSIVE_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

export function deferTombstoneRemoval(
  tombstonePath: string,
  onError?: (tombstonePath: string, err: Error) => void,
): void {
  rm(tombstonePath, RECURSIVE_REMOVE_OPTIONS).catch((rmErr) => {
    onError?.(tombstonePath, rmErr as Error);
  });
}

/**
 * Atomic Windows-safe directory removal.
 *
 * 1. Rename `installedManifestDir` → `<pluginsRoot>/+tombstones+/<id>-<ts>-<rand>`.
 *    On POSIX this succeeds even when a plugin worker still holds files
 *    inside. On Windows it succeeds only when those handles allow delete
 *    sharing; otherwise the rename throws and the caller surfaces the
 *    uninstall failure. The `<rand>` suffix prevents collisions when
 *    multiple uninstalls fire within the same millisecond.
 * 2. Fire-and-forget rm of the tombstone. On Windows the rm may fail with
 *    EBUSY if handles are still open — that's fine, the orphan sweeper at
 *    next boot picks up the leftover.
 *
 * `pluginsRoot` is required so the tombstone subdirectory ends up in the
 * canonical namespace (resolved via `lvisHome()` upstream — never hardcoded).
 *
 * Returns the tombstone path (for callers that want to log it), or null if
 * the install dir was already gone (concurrent uninstall race).
 */
export async function tombstoneAndDeferredRemove(
  installedManifestDir: string,
  pluginsRoot: string,
  options: {
    /** Override clock — tests pass a fixed value for deterministic naming. */
    now?: () => number;
    /** Override random suffix — tests pass a fixed value for assertions. */
    randomSuffix?: () => string;
    /** Hook for the deferred rm's failure path (default: silent). */
    onDeferredRmError?: (tombstonePath: string, err: Error) => void;
    /** Stage only; the caller commits metadata before scheduling removal. */
    deferRemoval?: boolean;
  } = {},
): Promise<string | null> {
  const tombstone = await renameAsideUnder(
    installedManifestDir,
    pluginsRoot,
    TOMBSTONE_SUBDIR,
    options,
  );
  if (tombstone !== null && options.deferRemoval !== false) {
    deferTombstoneRemoval(tombstone, options.onDeferredRmError);
  }
  return tombstone;
}

/**
 * Move a directory into {@link PARKED_PLUGIN_STATE_SUBDIR} and LEAVE IT THERE.
 *
 * The rename mechanics are the ones {@link tombstoneAndDeferredRemove} uses —
 * one atomic move into a namespace no plugin id can reach, with a timestamp and
 * a random suffix so concurrent parks cannot collide. What differs is the whole
 * point of the call: nothing is scheduled to delete this, and no sweeper looks
 * here. See {@link PARKED_PLUGIN_STATE_SUBDIR} for why that namespace is not
 * the tombstone one.
 *
 * Returns the parked path, or null if the directory was already gone.
 */
export async function parkUnattributedPluginState(
  dir: string,
  pluginsRoot: string,
  options: {
    /** Override clock — tests pass a fixed value for deterministic naming. */
    now?: () => number;
    /** Override random suffix — tests pass a fixed value for assertions. */
    randomSuffix?: () => string;
  } = {},
): Promise<string | null> {
  return renameAsideUnder(dir, pluginsRoot, PARKED_PLUGIN_STATE_SUBDIR, options);
}

/**
 * The move both namespaces share: one rename into `<pluginsRoot>/<subdir>/`
 * under a name that cannot collide. ENOENT means someone else already moved it,
 * which is an outcome rather than a failure for both callers.
 */
async function renameAsideUnder(
  dir: string,
  pluginsRoot: string,
  subdir: string,
  options: { now?: () => number; randomSuffix?: () => string },
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const randomSuffix =
    options.randomSuffix ?? (() => randomBytes(4).toString("hex"));

  const parent = join(pluginsRoot, subdir);
  // mkdir recursive is idempotent — safe across concurrent uninstalls. Fails
  // only on permission/disk-full errors, which would also fail the rename
  // below; let those surface.
  await mkdir(parent, { recursive: true });

  const basename = dir.split(/[\\/]/).pop() ?? "plugin";
  const moved = join(parent, `${basename}-${now()}-${randomSuffix()}`);
  try {
    await rename(dir, moved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return moved;
}
