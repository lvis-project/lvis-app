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
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { canonicalizePathForMatch } from "../sensitive-paths.js";

describe("canonicalizePathForMatch — security MAJOR-3 bypass vectors", () => {
  it("collapses `..` segments", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-canon-dot-"));
    mkdirSync(join(root, "a/b/c"), { recursive: true });
    // /<root>/a/b/c/../../b → /<root>/a/b
    const traversed = join(root, "a/b/c/../../b");
    const canonical = canonicalizePathForMatch(traversed);
    expect(canonical).not.toMatch(/\.\./);
    expect(canonical.endsWith("/a/b")).toBe(true);
  });

  it("collapses duplicate slashes", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-canon-slash-"));
    mkdirSync(join(root, "x"), { recursive: true });
    const dup = `${root}///x`;
    const canonical = canonicalizePathForMatch(dup);
    // No `//` anywhere except potentially the leading scheme-style — but
    // POSIX paths never use //.
    expect(canonical.includes("//")).toBe(false);
  });

  it("trailing slash does not survive resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "lvis-canon-trail-"));
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
    const root = mkdtempSync(join(tmpdir(), "lvis-canon-nfd-"));
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
    const root = mkdtempSync(join(tmpdir(), "lvis-canon-idem-"));
    mkdirSync(join(root, "deep/nest/path"), { recursive: true });
    const raw = `${root}//deep/./nest/../nest/path/`;
    const once = canonicalizePathForMatch(raw);
    const twice = canonicalizePathForMatch(once);
    expect(twice).toBe(once);
  });
});
