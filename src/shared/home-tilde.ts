import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

/**
 * Single source of truth for expanding a leading `~` in a path argument.
 *
 * WHY THIS IS ONE FUNCTION AND NOT FIVE
 * -------------------------------------
 * This string decides which file the PERMISSION layer judges AND which file
 * the TOOL opens. If the two sides expand differently, the Layer-0 sensitive
 * verdict, the approval modal text, the persisted grant pattern, and the audit
 * row are all computed about a file that is never touched. Agreement between
 * the sides IS the capability — there is no "stricter" variant that is also
 * correct, because a stricter-but-different answer still describes the wrong
 * file.
 *
 * Before consolidation this repo had five copies. Four handled `~` and `~/`
 * only; `resolveToolPathForPermission` (the permission side) additionally
 * handled `~\`. That one-sided branch is the drift: on win32 the tool opened
 * `<cwd>\~\Documents\x` while permission judged `<home>\Documents\x`.
 *
 * WHY `~\` IS PLATFORM-GUARDED
 * ----------------------------
 * Neither of the two prior behaviours was right on both platforms:
 *
 *  - On win32, `\` is a path separator, so `~\Documents\x` is the native form
 *    a Windows user types and MUST expand. Not expanding it (the four
 *    non-permission copies) makes the tool open a junk `<cwd>\~\...` path.
 *  - On POSIX, `\` is an ordinary, legal filename character, so
 *    `~\Documents\x` names ONE file called `~\Documents\x` in the current
 *    directory. Expanding it (the permission copy) makes the permission layer
 *    judge `$HOME/Documents/x` — a file the tool never opens.
 *
 * So the correct merge is neither side verbatim: expand `~\` if and only if
 * the platform treats `\` as a separator. `~` and `~/` expand everywhere —
 * `/` is a separator on win32 too.
 *
 * `~user` style is deliberately unsupported (POSIX-only concept, and the spec
 * scope is "the current user's home only"). It falls through unchanged.
 *
 * The platform is read per call, not captured at module load, so both branches
 * are reachable from tests on a single OS.
 */
export function expandLeadingTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return pathResolve(homedir(), path.slice(2));
  if (process.platform === "win32" && path.startsWith("~\\")) {
    return pathResolve(homedir(), path.slice(2));
  }
  return path;
}
