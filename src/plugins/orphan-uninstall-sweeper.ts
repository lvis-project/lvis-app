/**
 * Orphan-uninstall sweeper.
 *
 * The Windows-atomic uninstall path in `marketplace.removeInstalledEntry()`
 * renames the plugin's install dir to a `<dir>.uninstalling-<ts>` tombstone
 * before recursively removing it. The rm runs fire-and-forget so the registry
 * write can complete even if the plugin's worker still holds open file
 * handles (SQLite WAL/SHM, watchers, etc) — on Windows those handles cause
 * the rm to fail with EBUSY (errno -4082).
 *
 * Any tombstone left behind by a failed deferred rm is purged here, on the
 * next boot, when the previous worker process is guaranteed to be gone and
 * its handles released. macOS/Linux rarely produce tombstones (unlink of
 * open files succeeds) but the sweeper is OS-agnostic.
 *
 * Pattern matched: `<anything>.uninstalling-<digits>` directly under
 * pluginsRoot. The regex anchor on both sides prevents accidental matches
 * for plugins whose name happens to contain the substring.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("plugins/orphan-uninstall-sweeper");

const TOMBSTONE_RE = /\.uninstalling-\d+$/;

export async function sweepOrphanUninstallDirs(pluginsRoot: string): Promise<{
  swept: string[];
  failed: Array<{ name: string; error: string }>;
}> {
  let entries: string[];
  try {
    entries = await readdir(pluginsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Pre-first-install: pluginsRoot doesn't exist yet. Nothing to sweep.
      return { swept: [], failed: [] };
    }
    throw err;
  }

  const tombstones = entries.filter((name) => TOMBSTONE_RE.test(name));
  if (tombstones.length === 0) return { swept: [], failed: [] };

  const swept: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const name of tombstones) {
    const path = join(pluginsRoot, name);
    try {
      // Verify it's a directory — defense against accidentally matching a
      // non-directory entry that happens to share the suffix pattern.
      const st = await stat(path);
      if (!st.isDirectory()) continue;
      await rm(path, { recursive: true, force: true });
      swept.push(name);
      log.debug(`swept tombstone: ${name}`);
    } catch (err) {
      const msg = (err as Error).message;
      failed.push({ name, error: msg });
      // Still EBUSY → handle holder is somehow STILL alive across reboot
      // (extremely unusual — only possible if a non-LVIS process opened
      // the file). Leave for next boot rather than crashing.
      log.warn(`sweep failed for ${name}: ${msg}`);
    }
  }

  if (swept.length > 0) {
    log.info(`swept ${swept.length} orphan uninstall tombstone(s)`);
  }
  return { swept, failed };
}
