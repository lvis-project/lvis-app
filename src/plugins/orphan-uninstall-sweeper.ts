/**
 * Orphan-uninstall sweeper.
 *
 * The Windows-atomic uninstall path in `marketplace.removeInstalledEntry()`
 * renames the plugin's install dir to a tombstone under
 * `<pluginsRoot>/+tombstones+/<pluginId>-<ts>-<rand>` before recursively
 * removing it. The rm runs fire-and-forget so the registry write can
 * complete even if the plugin's worker still holds open file handles
 * (SQLite WAL/SHM, watchers, etc) — on Windows those handles cause the rm
 * to fail with EBUSY (errno -4082).
 *
 * Any tombstone left behind by a failed deferred rm is purged here, on the
 * next boot, when the previous worker process is guaranteed to be gone and
 * its handles released. macOS/Linux rarely produce tombstones (unlink of
 * open files succeeds) but the sweeper is OS-agnostic.
 *
 * ## Safety properties
 *
 * - **No collision with plugin dirs**: tombstones live in the
 *   `+tombstones+/` subdirectory whose name uses `+` (not in plugin id
 *   allowed chars `^[a-zA-Z0-9._-]+$`), so a malicious plugin slug can
 *   never be confused with a tombstone or trigger sweeping of an
 *   installed plugin's dir.
 * - **Symlink safety**: Node ≥16.7 `rm({recursive,force})` calls `lstat`
 *   first and severs symlinks rather than traversing into them, so a
 *   tombstone-named symlink to `~/.ssh` would only have the symlink
 *   removed, never the target.
 * - **Concurrent dev sessions**: idempotent. Two sessions sharing
 *   `pluginsRoot` may both attempt the same rm; the second sees ENOENT
 *   (silenced by `force: true`) and reports a noisy `failed[]` entry at
 *   worst — never data loss.
 *
 * ## Failure escalation
 *
 * Persistent failures (handle holder ≠ LVIS process — antivirus, indexer)
 * surface via `auditFailures` callback so operator/IT-admin gets a forensic
 * trail beyond the info-level log line.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { TOMBSTONE_SUBDIR } from "./installed-entry-fs.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("plugins/orphan-uninstall-sweeper");

export interface SweepResult {
  /** Tombstone basenames successfully removed. */
  swept: string[];
  /** Tombstones whose rm failed (likely a non-LVIS process holding a handle). */
  failed: Array<{ name: string; error: string }>;
}

export async function sweepOrphanUninstallDirs(
  pluginsRoot: string,
  options: {
    /** Audit-log emitter for the persistent-failure escalation path. */
    auditFailures?: (failures: SweepResult["failed"]) => void;
  } = {},
): Promise<SweepResult> {
  const tombstoneDir = join(pluginsRoot, TOMBSTONE_SUBDIR);

  let entries: string[];
  try {
    entries = await readdir(tombstoneDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No tombstone subdir yet — pre-first-uninstall. Nothing to sweep.
      return { swept: [], failed: [] };
    }
    throw err;
  }

  if (entries.length === 0) return { swept: [], failed: [] };

  // Parallel sweep — sequential serialized IO unnecessarily on heavy
  // uninstall sessions (10+ tombstones can pile up after a managed-plugin
  // refresh cycle).
  const results = await Promise.allSettled(
    entries.map(async (name) => {
      const path = join(tombstoneDir, name);
      // Guard against a non-directory entry sneaking into the subdir
      // (host bug, manual fs poking). Only directories should be there.
      const st = await stat(path);
      if (!st.isDirectory()) return null;
      await rm(path, { recursive: true, force: true });
      return name;
    }),
  );

  const result: SweepResult = { swept: [], failed: [] };
  results.forEach((r, idx) => {
    const name = entries[idx];
    if (r.status === "fulfilled") {
      if (r.value) {
        result.swept.push(r.value);
        log.debug(`swept tombstone: ${r.value}`);
      }
    } else {
      const msg = (r.reason as Error).message;
      result.failed.push({ name, error: msg });
      log.warn(`sweep failed for ${name}: ${msg}`);
    }
  });

  if (result.swept.length > 0) {
    log.info(`swept ${result.swept.length} orphan uninstall tombstone(s)`);
  }
  // Escalate persistent failures so operator/IT can investigate (typically
  // antivirus or indexer holding a handle past process death).
  if (result.failed.length > 0 && options.auditFailures) {
    try {
      options.auditFailures(result.failed);
    } catch (err) {
      log.warn(`auditFailures hook threw: ${(err as Error).message}`);
    }
  }
  return result;
}
