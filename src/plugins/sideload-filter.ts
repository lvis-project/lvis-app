import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/**
 * Returns a `node:fs/promises.cp({ filter })` callback that skips trees
 * hostile to recursive copy (Electron's bundled asar archives) and
 * unwanted metadata (.git). Covers monorepo layouts where `node_modules`
 * may be nested under any package path.
 */
export function buildSideloadCopyFilter(sourceRoot: string): (src: string) => boolean {
  return (src: string): boolean => {
    const rel = relative(sourceRoot, src);
    if (!rel) return true;
    const parts = rel.split(/[\\/]/);
    if (parts[0] === ".git") return false;
    const nmIdx = parts.indexOf("node_modules");
    if (nmIdx >= 0) {
      const next = parts[nmIdx + 1];
      if (next === "electron" || next === "@electron") return false;
    }
    return true;
  };
}

/**
 * Walks all symlinks under `dir` recursively and throws if any symlink's
 * realpath escapes `dir`. Call this on the staging directory BEFORE rename
 * so a failed check never leaves the live install path half-written.
 */
export async function rejectEscapingSymlinks(dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw new Error(`rejectEscapingSymlinks: dir must be absolute, got: ${dir}`);
  const realRoot = realpathSync(dir);
  await walkForEscapingSymlinks(dir, realRoot);
}

async function walkForEscapingSymlinks(current: string, realRoot: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = realpathSync(full);
      } catch {
        // dangling or circular symlink (ENOENT / ELOOP) — reject rather than
        // silently skip, since the target could later be created to point outside
        // the install dir after the containment check has already passed.
        throw new Error(
          `[installLocal] unresolvable symlink in install dir: ${relative(realRoot, full)}`,
        );
      }
      if (!isContained(realRoot, realTarget)) {
        throw new Error(
          `[installLocal] symlink escapes install dir: ${relative(realRoot, full)} → ${realTarget}`,
        );
      }
    } else if (entry.isDirectory()) {
      await walkForEscapingSymlinks(full, realRoot);
    }
  }
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  // Empty rel means target === root (same path) — treat as contained.
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
