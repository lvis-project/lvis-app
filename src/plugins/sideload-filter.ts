import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/**
 * Returns a `node:fs/promises.cp({ filter })` callback that skips trees
 * hostile to recursive copy (Electron's bundled asar archives) and
 * unwanted metadata (.git). Covers monorepo layouts where `node_modules`
 * may be nested under any package path.
 *
 * `node_modules/.bin/` is also skipped: it is full of symlinks to package
 * CLIs (e.g. `.bin/electron → ../electron/cli.js`). Once the `electron`
 * package itself is filtered out above, those `.bin/*` symlinks become
 * dangling, and `rejectEscapingSymlinks()` rejects the entire install with
 * "unresolvable symlink in install dir: node_modules/.bin/electron". The
 * plugin runtime never invokes `.bin` binaries anyway — they are dev-only
 * shell shims — so dropping the whole subtree is loss-free.
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
      if (next === "electron" || next === "@electron" || next === ".bin") return false;
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
  // Use async realpath — consistent with the surrounding async install path;
  // avoids blocking the event loop on a cold filesystem.
  const realRoot = await realpath(dir);
  // Walk from realRoot (canonical) so all paths built via join() inside the
  // walk are canonical too — this ensures relative(realRoot, full) in error
  // messages produces clean relative paths without spurious ../ segments.
  await walkForEscapingSymlinks(realRoot, realRoot);
}

async function walkForEscapingSymlinks(current: string, realRoot: string): Promise<void> {
  // Fail-closed: any readdir error (including ENOENT from a race condition
  // where a directory disappears mid-walk) is propagated — silently skipping
  // would leave the containment check incomplete.
  const entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = await realpath(full);
      } catch {
        // Dangling or circular symlink (ENOENT / ELOOP) — target is unverifiable
        // at install time. Reject rather than silently skip: a dangling target
        // could later be created to point outside the install root, bypassing
        // this containment check (defense-in-depth).
        throw new Error(
          `[installLocal] unresolvable symlink in install dir: ${relative(realRoot, full)}`,
        );
      }
      if (!isContained(realRoot, realTarget)) {
        // Canonical paths on both sides: `full` is built by joining from
        // realRoot (canonical) so relative(realRoot, full) is a clean relative
        // path. realTarget is the already-resolved canonical path from realpath().
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
