/**
 * Recursive source-file listing for the `check-*.mjs` gates.
 *
 * WHY THIS IS A LEAF. Every `check-*.mjs` runs its scan at import time, so a
 * gate cannot borrow another gate's walker without also running that gate.
 * Five scripts had therefore grown five walkers — `check-color-tokens`,
 * `check-opacity-tokens`, `check-no-tls-bypass`, `check-source-text-safe`,
 * `check-test-duplicates` — that agreed on the recursion and disagreed on the
 * skip set, the error handling, and which of them carried the CodeQL note.
 * One walker, one option surface, one note.
 *
 * `withFileTypes` carries the entry type on the dirent itself. That avoids a
 * separate `statSync(path)` between the directory listing and the read, which
 * CodeQL flags as a file-system race: the path could be swapped for a symlink
 * or another inode in that window.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * List every regular file under `dir`, depth first, in directory order.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {ReadonlySet<string>} [options.skipDirs] directory NAMES (not paths)
 *   that are not descended into, at any depth.
 * @param {readonly string[]} [options.extensions] keep only files whose name
 *   ends with one of these (write the dot: `".ts"`). Omit to keep every file.
 * @param {(path: string) => boolean} [options.accept] final per-file filter.
 * @param {boolean} [options.tolerateUnreadableDirs] `true` treats a directory
 *   that cannot be listed (absent, unreadable) as empty instead of throwing.
 * @param {string[]} [out]
 * @returns {string[]} absolute paths when `dir` is absolute.
 */
export function walkSourceFiles(dir, options = {}, out = []) {
  const {
    skipDirs = new Set(),
    extensions,
    accept,
    tolerateUnreadableDirs = false,
  } = options;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (tolerateUnreadableDirs) return out;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkSourceFiles(path, options, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions && !extensions.some((extension) => entry.name.endsWith(extension))) {
      continue;
    }
    if (accept && !accept(path)) continue;
    out.push(path);
  }
  return out;
}
