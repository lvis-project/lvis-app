/**
 * Q12 Phase 2.5 — Layer 1 (Path policy) — allowed directories tests.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 1.
 */
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import {
  isPathAllowed,
  pickClosestParent,
  validateDirectoryAddition,
  sanitizeAllowedDirectories,
  computeDefaultAllowedDirectories,
  buildAllowedScope,
} from "../allowed-directories.js";
import {
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "../sensitive-paths.js";

function fold(raw: string): string {
  return caseFoldForMatch(canonicalizePathForMatch(raw));
}

describe("isPathAllowed — prefix match", () => {
  it("returns true for exact match", () => {
    const dir = fold("/Users/ken/work/proj");
    expect(isPathAllowed(dir, { directories: [dir] })).toBe(true);
  });

  it("returns true for child path", () => {
    const dir = fold("/Users/ken/work/proj");
    const child = fold("/Users/ken/work/proj/src/index.ts");
    expect(isPathAllowed(child, { directories: [dir] })).toBe(true);
  });

  it("returns false for sibling that shares a prefix-substring", () => {
    const dir = fold("/Users/ken/work/proj");
    const sibling = fold("/Users/ken/work/proj-sneaky/data.txt");
    expect(isPathAllowed(sibling, { directories: [dir] })).toBe(false);
  });

  it("returns false for parent of allowed dir", () => {
    const dir = fold("/Users/ken/work/proj");
    const parent = fold("/Users/ken/work");
    expect(isPathAllowed(parent, { directories: [dir] })).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isPathAllowed("", { directories: [fold("/Users/ken")] })).toBe(false);
  });

  it("returns false for empty directories list (deny-by-default)", () => {
    expect(isPathAllowed(fold("/Users/ken/work"), { directories: [] })).toBe(false);
  });

  it("matches against multiple allowed dirs", () => {
    const a = fold("/Users/ken/work/a");
    const b = fold("/Users/ken/work/b");
    const childOfB = fold("/Users/ken/work/b/file.ts");
    expect(isPathAllowed(childOfB, { directories: [a, b] })).toBe(true);
  });
});

describe("isPathAllowed — Layer 0 deny still wins", () => {
  it("Layer 0 deny dominates (caller responsibility — see executor wiring)", () => {
    // Note: isPathAllowed itself only does prefix logic. The executor is
    // expected to run sensitive-path check FIRST. This test documents the
    // contract — adding ~/.lvis to additionalDirectories doesn't bypass
    // Layer 0 because Layer 0 fires before Layer 1 in the executor pipeline.
    const dir = fold(pathResolve(homedir(), ".lvis"));
    const sensitive = fold(pathResolve(homedir(), ".lvis/secrets/openai.key"));
    // Layer 1 alone considers the child allowed (parent dir matches);
    // Layer 0 elsewhere will block it.
    expect(isPathAllowed(sensitive, { directories: [dir] })).toBe(true);
    // sanitizeAllowedDirectories drops ~/.lvis/secrets explicitly.
    const sanitized = sanitizeAllowedDirectories([
      pathResolve(homedir(), ".lvis/secrets"),
    ]);
    expect(sanitized).toEqual([]);
  });
});

describe("pickClosestParent — leaf-parent UX rule", () => {
  it("returns the immediate parent of the leaf", () => {
    const leaf = fold("/Users/ken/Documents/old-project/notes/today/foo.md");
    const expected = fold("/Users/ken/Documents/old-project/notes/today");
    expect(pickClosestParent(leaf, [])).toBe(expected);
  });

  it("returns null when leaf is already inside a current allowed dir", () => {
    const dir = fold("/Users/ken/work");
    const leaf = fold("/Users/ken/work/proj/src/index.ts");
    expect(pickClosestParent(leaf, [dir])).toBeNull();
  });

  it("returns null when the parent is itself a Layer 0 sensitive directory", () => {
    // Generic id_rsa under any folder is Layer 0; the parent folder may
    // not be sensitive but a deeper one inside .ssh is.
    const leaf = fold("/Users/ken/.ssh/id_rsa");
    // The leaf-parent is `~/.ssh` which is NOT itself a sensitive
    // *directory pattern* in the list (only `**/.ssh/*` files are).
    // The parent's parent (`~`) is fine. So the immediate parent is the
    // .ssh dir — and isSensitivePath('/Users/ken/.ssh') matches
    // `**/.ssh/*` via the directory-form trailing-slash trick.
    expect(pickClosestParent(leaf, [])).toBeNull();
  });

  it("never suggests the broadest common-prefix parent (only leaf-parent)", () => {
    // Confirm we don't accidentally walk multiple levels up.
    const leaf = fold("/Users/ken/Documents/a/b/c/file.txt");
    const result = pickClosestParent(leaf, []);
    expect(result).toBe(fold("/Users/ken/Documents/a/b/c"));
    // Definitely NOT the user's Documents root.
    expect(result).not.toBe(fold("/Users/ken/Documents"));
  });
});

describe("validateDirectoryAddition", () => {
  it("rejects empty path", () => {
    const r = validateDirectoryAddition("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("empty");
  });

  it("rejects whitespace-only path", () => {
    const r = validateDirectoryAddition("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects filesystem root", () => {
    const r = validateDirectoryAddition("/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("root");
  });

  it("rejects sensitive path (~/.lvis/secrets)", () => {
    const r = validateDirectoryAddition(
      pathResolve(homedir(), ".lvis/secrets"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sensitive");
  });

  it("accepts a normal project directory", () => {
    const r = validateDirectoryAddition("/Users/ken/work/proj");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adjacencyWarnings).toEqual([]);
  });

  it("warns when path contains '.env' segment", () => {
    const r = validateDirectoryAddition("/Users/ken/work/proj/.env");
    // .env file is itself sensitive (Layer 0), so this is rejected;
    // adjacency warning is for a directory that *contains* such a child.
    expect(r.ok).toBe(false); // Layer 0 wins
  });

  it("warns when path contains '.git' adjacency", () => {
    const r = validateDirectoryAddition("/Users/ken/work/proj/.git");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.adjacencyWarnings.some((w) => w.includes(".git"))).toBe(true);
  });

  it("warns when path contains 'credentials' segment", () => {
    const r = validateDirectoryAddition("/Users/ken/work/credentials");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(
        r.adjacencyWarnings.some((w) => w.includes("credentials")),
      ).toBe(true);
  });

  it("warns when path contains 'node_modules/.cache'", () => {
    const r = validateDirectoryAddition("/Users/ken/work/proj/node_modules/.cache");
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(
        r.adjacencyWarnings.some((w) => w.includes("node_modules")),
      ).toBe(true);
  });

  it("expands ~ to homedir()", () => {
    const r = validateDirectoryAddition("~/myproject");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonicalPath).toContain("myproject");
  });
});

describe("sanitizeAllowedDirectories", () => {
  it("returns empty for undefined input", () => {
    expect(sanitizeAllowedDirectories(undefined)).toEqual([]);
  });

  it("returns empty for empty array", () => {
    expect(sanitizeAllowedDirectories([])).toEqual([]);
  });

  it("drops sensitive entries silently", () => {
    const result = sanitizeAllowedDirectories([
      "/Users/ken/work",
      pathResolve(homedir(), ".lvis/secrets"),
      "/Users/ken/Documents",
    ]);
    expect(result).toContain(fold("/Users/ken/work"));
    expect(result).toContain(fold("/Users/ken/Documents"));
    expect(result).not.toContain(fold(pathResolve(homedir(), ".lvis/secrets")));
  });

  it("de-duplicates equivalent entries (different case on darwin)", () => {
    const result = sanitizeAllowedDirectories([
      "/Users/ken/Work",
      "/Users/ken/work",
    ]);
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(result.length).toBe(1);
    } else {
      // Linux is case-sensitive — both entries kept.
      expect(result.length).toBe(2);
    }
  });

  it("expands ~ in entries", () => {
    const result = sanitizeAllowedDirectories(["~/myapp"]);
    expect(result.length).toBe(1);
    expect(result[0]).toContain("myapp");
  });
});

describe("computeDefaultAllowedDirectories", () => {
  it("includes process.cwd() and ~/.lvis (modulo Layer 0)", () => {
    const result = computeDefaultAllowedDirectories();
    expect(result.length).toBeGreaterThanOrEqual(1);
    // ~/.lvis is allowed here as a parent dir (sensitive *children* are
    // hard-blocked by Layer 0 but the dir itself is fine).
    const lvisDir = fold(pathResolve(homedir(), ".lvis"));
    expect(result).toContain(lvisDir);
  });

  it("returns canonical + case-folded entries", () => {
    const result = computeDefaultAllowedDirectories();
    for (const dir of result) {
      // Canonical paths never contain `..`.
      expect(dir.includes("/..")).toBe(false);
    }
  });
});

describe("buildAllowedScope", () => {
  it("merges defaults with user additions", () => {
    const scope = buildAllowedScope(["/Users/ken/Documents"]);
    expect(scope.directories.length).toBeGreaterThanOrEqual(2);
    expect(scope.directories).toContain(fold("/Users/ken/Documents"));
  });

  it("handles undefined user additions (default-only scope)", () => {
    const scope = buildAllowedScope(undefined);
    expect(scope.directories.length).toBeGreaterThanOrEqual(1);
  });

  it("de-duplicates when user adds a default dir", () => {
    const scope = buildAllowedScope([
      pathResolve(homedir(), ".lvis"),
      pathResolve(homedir(), ".lvis"),
    ]);
    const lvisDir = fold(pathResolve(homedir(), ".lvis"));
    const occurrences = scope.directories.filter((d) => d === lvisDir).length;
    expect(occurrences).toBe(1);
  });
});
