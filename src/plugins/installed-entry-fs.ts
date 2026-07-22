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
  const now = options.now ?? Date.now;
  const randomSuffix =
    options.randomSuffix ?? (() => randomBytes(4).toString("hex"));

  const tombstoneDir = join(pluginsRoot, TOMBSTONE_SUBDIR);
  // Ensure the tombstone subdir exists. mkdir recursive is idempotent —
  // safe across concurrent uninstalls. Fails only on permission/disk-full
  // errors, which would also fail the rename below; let those surface.
  await mkdir(tombstoneDir, { recursive: true });

  const basename = installedManifestDir.split(/[\\/]/).pop() ?? "plugin";
  const tombstone = join(tombstoneDir, `${basename}-${now()}-${randomSuffix()}`);
  try {
    await rename(installedManifestDir, tombstone);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (options.deferRemoval !== false) {
    deferTombstoneRemoval(tombstone, options.onDeferredRmError);
  }
  return tombstone;
}
