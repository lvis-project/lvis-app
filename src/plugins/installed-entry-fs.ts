/**
 * Filesystem helpers for plugin install dir removal.
 *
 * Extracted from `marketplace.removeInstalledEntry` so the Windows-atomic
 * uninstall semantics (rename → defer rm) can be unit-tested without
 * standing up a full PluginMarketplaceService.
 */

import { rename, rm } from "node:fs/promises";

/**
 * Atomic Windows-safe directory removal.
 *
 * 1. Rename `installedManifestDir` → `<dir>.uninstalling-<ts>` (tombstone).
 *    NTFS allows directory rename with open file handles inside (handles
 *    use file references, not paths), so this succeeds even when a plugin
 *    worker still holds SQLite WAL/SHM files. macOS/Linux always succeed.
 * 2. Fire-and-forget rm of the tombstone. On Windows the rm may fail with
 *    EBUSY if handles are still open — that's fine, the orphan sweeper at
 *    next boot picks up the leftover.
 *
 * Returns the tombstone path (for callers that want to log it), or null if
 * the install dir was already gone (concurrent uninstall race).
 */
export async function tombstoneAndDeferredRemove(
  installedManifestDir: string,
  options: {
    /** Override clock — tests pass a fixed value for deterministic naming. */
    now?: () => number;
    /** Hook for the deferred rm's failure path (default: silent). */
    onDeferredRmError?: (tombstonePath: string, err: Error) => void;
  } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const tombstone = `${installedManifestDir}.uninstalling-${now()}`;
  try {
    await rename(installedManifestDir, tombstone);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  rm(tombstone, { recursive: true, force: true }).catch((rmErr) => {
    options.onDeferredRmError?.(tombstone, rmErr as Error);
  });
  return tombstone;
}
