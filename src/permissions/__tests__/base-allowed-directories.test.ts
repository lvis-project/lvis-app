/**
 * Temp directories are reachable in every conversation.
 *
 * Two things had to be true and neither was:
 *
 * 1. The grant has to survive `newConversation()`. `applyProjectContext`
 *    reassigns `sessionAdditionalDirectories` to `[projectRoot]` on every new
 *    chat, so a directory approved with scope "session" is discarded — which is
 *    why a path that worked a moment ago starts asking again. The base set is
 *    assembled per turn instead, so it cannot be reset away.
 *
 * 2. `/tmp` has to actually match. On macOS `os.tmpdir()` resolves to the
 *    per-user `$TMPDIR` (`/var/folders/…`), NOT `/tmp`, and `/tmp` is itself a
 *    symlink to `/private/tmp`. Covering only `os.tmpdir()` would leave the path
 *    people actually type still denied, and comparing unresolved strings would
 *    make `/tmp/x` and `/private/tmp/x` look like different directories.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { baseAllowedDirectories } from "../base-allowed-directories.js";
import { isPathAllowed } from "../allowed-directories.js";
import { canonicalizePathForMatch } from "../sensitive-paths.js";

/**
 * Mirror a real caller: canonicalize the candidate, then match.
 *
 * Note this does NOT case-fold. `sanitizeRuntimeAllowedDirectories` — the
 * "runtime" variant the base set goes through — stores canonical paths with
 * their original case (macOS `$TMPDIR` ends in an uppercase `T`), so folding
 * only one side would never match.
 */
function allowed(candidate: string): boolean {
  return isPathAllowed(canonicalizePathForMatch(candidate), {
    directories: baseAllowedDirectories(),
  });
}

describe("base allowed directories", () => {
  it("includes the per-user temp directory, canonicalized", () => {
    expect(baseAllowedDirectories()).toContain(canonicalizePathForMatch(tmpdir()));
  });

  it("allows a file staged under the per-user temp directory", () => {
    expect(allowed(join(tmpdir(), "lvis-scratch", "notes.txt"))).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "allows the conventional shared /tmp through its symlink",
    () => {
      // The real regression: this project's own workflow clones into
      // /tmp/<task>/<repo>, which on macOS resolves to /private/tmp/... —
      // both spellings must match the one stored entry.
      expect(allowed("/tmp/some-task/repo/src/index.ts")).toBe(true);
      expect(allowed("/private/tmp/some-task/repo/src/index.ts")).toBe(true);
    },
  );

  it("does not allow paths outside any temp directory", () => {
    // Deliberately not `process.cwd()`: this suite is itself often run from a
    // clone under /tmp, where cwd IS allowed — asserting otherwise would fail
    // for the same reason the feature works.
    expect(allowed("/etc/passwd")).toBe(false);
    expect(allowed("/usr/local/lib/thing.js")).toBe(false);
  });

  it("does not allow a sibling whose name merely starts with the temp path", () => {
    // Segment-aligned matching, not string prefix: `/tmpfoo` is not under `/tmp`.
    expect(allowed("/tmpfoo/secret")).toBe(false);
  });

  it("returns each directory once", () => {
    const base = baseAllowedDirectories();
    expect(new Set(base).size).toBe(base.length);
  });
});
