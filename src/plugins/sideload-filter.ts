import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { isPluginRuntimeDirName } from "./plugin-storage-layout.js";

/**
 * Returns a `node:fs/promises.cp({ filter })` callback that skips trees
 * hostile to recursive copy (Electron's bundled asar archives) and
 * unwanted metadata (.git). Covers monorepo layouts where `node_modules`
 * may be nested under any package path.
 *
 * `node_modules/.bin/` is also skipped: it is full of symlinks to package
 * CLIs (e.g. `.bin/electron → ../electron/cli.js`). Sideload validation
 * rejects every symlink, while the plugin runtime never invokes `.bin`
 * binaries anyway, so dropping the whole subtree is loss-free.
 */
export function buildSideloadCopyFilter(sourceRoot: string): (src: string) => boolean {
  return (src: string): boolean => {
    const rel = relative(sourceRoot, src);
    if (!rel) return true;
    const parts = rel.split(/[\\/]/);
    // Same refusal the marketplace path makes in `sanitizeZipEntryPath`, for
    // the same reason: a sideload source holding a top-level runtime directory
    // would promote a second candidate for the plugin's state into the root
    // the swap is about to carry the live one into. Thrown rather than
    // filtered out — `cp` propagates it — because a developer whose source
    // tree has a `data/` in it needs to be told, not quietly trimmed.
    if (parts.length === 1 && isPluginRuntimeDirName(parts[0]!)) {
      throw new Error(
        `[installLocal] plugin source may not contain a top-level runtime directory: ${rel}`,
      );
    }
    if (parts[0] === ".git") return false;
    const nmIdx = parts.indexOf("node_modules");
    if (nmIdx >= 0) {
      const next = parts[nmIdx + 1];
      if (next === "electron" || next === "@electron" || next === ".bin") return false;
    }
    return true;
  };
}

/**
 * Reject every symlink under `dir` before a sideload candidate is promoted.
 *
 * Receipt integrity also rejects symlinks, but staging must apply the same
 * policy before any payload can reach the live install path. Call this on the
 * staging directory BEFORE rename so a failed check never leaves live bytes.
 */
export async function rejectSideloadSymlinks(dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw new Error(`rejectSideloadSymlinks: dir must be absolute, got: ${dir}`);
  await walkForSideloadSymlinks(dir, dir);
}

async function walkForSideloadSymlinks(current: string, root: string): Promise<void> {
  // Fail-closed: any readdir error (including ENOENT from a race condition
  // where a directory disappears mid-walk) is propagated — silently skipping
  // would leave the containment check incomplete.
  const entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `[installLocal] symbolic link is not allowed in install dir: ${relative(root, full)}`,
      );
    } else if (entry.isDirectory()) {
      await walkForSideloadSymlinks(full, root);
    }
  }
}
