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
 *    per-user `$TMPDIR` (`/var/folders/…`), NOT `/tmp`, and on CI it resolves to
 *    a runner-specific directory. Covering only `os.tmpdir()` leaves the path
 *    people actually type still denied.
 *
 * These assert the INVARIANT — every base candidate ends up matchable through
 * the real scope builder — rather than that any particular literal path exists.
 * An earlier version asserted `/tmp/...` directly and passed on macOS while
 * failing on Linux CI, which is the wrong thing to pin: the guarantee is "what
 * this function offers is honoured", not "this machine has that directory".
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { baseAllowedDirectories } from "../base-allowed-directories.js";
import { buildAllowedScope, isPathAllowed } from "../allowed-directories.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";

/**
 * Match the way the product does: candidates go through `buildAllowedScope`,
 * which canonicalizes and case-folds them, and the probe path is normalized the
 * same way before the segment-aligned compare.
 */
function allowedUnderBase(candidate: string): boolean {
  const scope = buildAllowedScope(baseAllowedDirectories());
  return isPathAllowed(caseFoldForMatch(canonicalizePathForMatch(candidate)), scope);
}

describe("base allowed directories", () => {
  it("offers at least the per-user temp directory", () => {
    expect(baseAllowedDirectories()).toContain(tmpdir());
  });

  it("makes a child of every offered candidate reachable", () => {
    // The invariant that matters, and the one that holds on any platform:
    // whatever this function offers must survive the scope builder and match.
    for (const dir of baseAllowedDirectories()) {
      expect(allowedUnderBase(join(dir, "lvis-scratch", "notes.txt"))).toBe(true);
    }
  });

  it("reaches a file staged under the per-user temp directory", () => {
    expect(allowedUnderBase(join(tmpdir(), "lvis-scratch", "notes.txt"))).toBe(true);
  });

  it.runIf(process.platform !== "win32")("offers the conventional shared /tmp on POSIX", () => {
    // The reported case: this project's workflow clones into /tmp/<task>/<repo>,
    // which `os.tmpdir()` alone would not cover.
    expect(baseAllowedDirectories()).toContain("/tmp");
  });

  it("does not offer a shared POSIX path on Windows", () => {
    if (process.platform !== "win32") return;
    expect(baseAllowedDirectories()).not.toContain("/tmp");
  });

  it("does not make unrelated paths reachable", () => {
    // Deliberately not `process.cwd()`: this suite often runs from a clone under
    // a temp directory, where cwd genuinely IS reachable — asserting otherwise
    // would fail for the same reason the feature works.
    expect(allowedUnderBase("/etc/shadow")).toBe(false);
  });
});
