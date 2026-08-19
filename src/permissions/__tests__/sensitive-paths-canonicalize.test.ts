/**
 * Security MAJOR-3 (PR #860) — canonicalizePathForMatch() coverage for
 * the bypass vectors the cluster review identified:
 *
 *   - `..` traversal segments
 *   - NFD-decomposed Unicode forms
 *   - mixed-case on darwin/win32 (case-insensitive filesystems)
 *   - trailing slash
 *   - duplicate slashes
 *
 * The frozen-canonical contract requires both sides of the prefix compare
 * (sensitive-path layer + allowed-dir layer + sandbox-write rule) to see
 * BIT-IDENTICAL strings, so any bypass vector that survives canonicalize()
 * is a security regression.
 *
 * These tests use `realpath`'d tmpdir paths to keep the test
 * fs-independent (darwin /var → /private/var symlink).
 */
import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalizePathForMatch, foldCanonicalPathSeparators } from "../sensitive-paths.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();

afterEach(async () => {
  await resources.cleanup();
});

describe("canonicalizePathForMatch — security MAJOR-3 bypass vectors", () => {
  it("collapses `..` segments", () => {
    const root = resources.makeTmpDir("lvis-canon-dot-");
    mkdirSync(join(root, "a/b/c"), { recursive: true });
    // /<root>/a/b/c/../../b → /<root>/a/b
    const traversed = join(root, "a/b/c/../../b");
    const canonical = canonicalizePathForMatch(traversed);
    expect(canonical).not.toMatch(/\.\./);
    expect(canonical.endsWith("/a/b")).toBe(true);
  });

  it("collapses duplicate slashes", () => {
    const root = resources.makeTmpDir("lvis-canon-slash-");
    mkdirSync(join(root, "x"), { recursive: true });
    const dup = `${root}///x`;
    const canonical = canonicalizePathForMatch(dup);
    // No `//` anywhere except potentially the leading scheme-style — but
    // POSIX paths never use //.
    expect(canonical.includes("//")).toBe(false);
  });

  it("trailing slash does not survive resolve", () => {
    const root = resources.makeTmpDir("lvis-canon-trail-");
    mkdirSync(join(root, "leaf"), { recursive: true });
    const trailed = `${root}/leaf/`;
    const canonical = canonicalizePathForMatch(trailed);
    // path.resolve trims the trailing separator
    expect(canonical.endsWith("/")).toBe(false);
    expect(canonical.endsWith("/leaf")).toBe(true);
  });

  it("NFD-decomposed unicode normalizes to NFC", () => {
    // "café" — composed (NFC) e + ́ and decomposed (NFD).
    const nfc = "café"; // 4 code points (composed)
    const nfd = "café"; // 5 code points (decomposed)
    const root = resources.makeTmpDir("lvis-canon-nfd-");
    const composed = canonicalizePathForMatch(`${root}/${nfc}`);
    const decomposed = canonicalizePathForMatch(`${root}/${nfd}`);
    // After NFC normalization both forms collapse to the same string.
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));
    // canonicalizePathForMatch already applies .normalize("NFC") so the
    // raw outputs must also match.
    expect(composed).toBe(decomposed);
  });

  it("path produces an absolute resolved string", () => {
    const canonical = canonicalizePathForMatch("relative/path/file.txt");
    // Must be absolute (path.resolve at minimum prepends cwd). On Windows
    // canonicalizePathForMatch normalizes separators to `/`, but the drive
    // prefix remains absolute.
    expect(isAbsolute(canonical)).toBe(true);
    // No `.` or `..` segments leak through
    expect(canonical.includes("/../")).toBe(false);
    expect(canonical.includes("/./")).toBe(false);
  });

  it("repeated canonicalize is idempotent (frozen-canonical contract)", () => {
    const root = resources.makeTmpDir("lvis-canon-idem-");
    mkdirSync(join(root, "deep/nest/path"), { recursive: true });
    const raw = `${root}//deep/./nest/../nest/path/`;
    const once = canonicalizePathForMatch(raw);
    const twice = canonicalizePathForMatch(once);
    expect(twice).toBe(once);
  });
});

/**
 * Windows shapes are pinned against the pure fold rather than
 * `canonicalizePathForMatch`, because `resolve`/`realpath` follow the HOST's
 * rules: on the macOS and Linux machines this suite runs on, a
 * `\\server\share\...` string is just a filename containing backslashes, so
 * the win32 branch would never execute.
 */
describe("foldCanonicalPathSeparators — win32 shapes", () => {
  it("keeps the leading pair of a UNC path, which names the share", () => {
    // What `realpathSync.native` hands back for a mapped network drive (Z:\proj)
    // as well as for a directly picked \\server\share\proj.
    expect(foldCanonicalPathSeparators("\\\\server\\share\\proj", "win32"))
      .toBe("//server/share/proj");
  });

  it("keeps the device-namespace prefix", () => {
    // The drive letter stays cased here because the lowercase rule is anchored
    // at the start of the string and this shape puts `//?/` there. Matching is
    // unaffected: `caseFoldForMatch` folds the whole path on win32.
    expect(foldCanonicalPathSeparators("\\\\?\\C:\\proj", "win32")).toBe("//?/C:/proj");
  });

  it("still collapses duplicate separators inside the path", () => {
    expect(foldCanonicalPathSeparators("\\\\server\\share\\\\a\\\\b", "win32"))
      .toBe("//server/share/a/b");
  });

  it("lowercases only the drive letter", () => {
    expect(foldCanonicalPathSeparators("C:\\Work\\Beta", "win32")).toBe("c:/Work/Beta");
  });

  it("does not invent a leading pair off win32", () => {
    expect(foldCanonicalPathSeparators("//server/share/proj", "linux")).toBe("/server/share/proj");
  });
});
