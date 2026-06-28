/**
 * SandboxPathValidator (Tier A3) unit tests.
 *
 * Uses real tempdirs (os.tmpdir) + real symlinks to exercise the
 * realpath-based traversal defense. Tempdirs are cleaned up in
 * afterEach to keep the test environment hermetic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { validateSandboxPath } from "../path-validator.js";

const dirLinkType = process.platform === "win32" ? "junction" : "dir";

describe("validateSandboxPath", () => {
  let sandboxCwd: string;
  let outsideDir: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    // realpathSync resolves /var → /private/var on macOS so the assertions
    // later in this file match canonicalized form.
    sandboxCwd = realpathSync(mkdtempSync(join(tmpdir(), "lvis-sandbox-")));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "lvis-outside-")));
    cleanup.push(sandboxCwd, outsideDir);
  });

  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()!;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("allows a path inside the sandbox cwd", () => {
    const inside = join(sandboxCwd, "docs", "readme.md");
    mkdirSync(join(sandboxCwd, "docs"));
    writeFileSync(inside, "hello");

    const result = validateSandboxPath(inside, sandboxCwd);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("");
  });

  it("denies a path outside the sandbox cwd with a reason", () => {
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "secret");

    const result = validateSandboxPath(outsideFile, sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
    expect(result.reason).toContain(sandboxCwd);
  });

  it("expands ~/ to the user's home directory", () => {
    const home = realpathSync(homedir());
    const result = validateSandboxPath("~/", home);
    expect(result.allowed).toBe(true);
  });

  it("expands bare ~ to the user's home directory", () => {
    const home = realpathSync(homedir());
    const result = validateSandboxPath("~", home);
    expect(result.allowed).toBe(true);
  });

  it("allows a path inside an extraAllowed directory", () => {
    const allowedFile = join(outsideDir, "allowed.log");
    writeFileSync(allowedFile, "log");

    const result = validateSandboxPath(allowedFile, sandboxCwd, [outsideDir]);
    expect(result.allowed).toBe(true);
  });

  it("blocks symlink traversal when target is outside the sandbox", () => {
    // Use a directory link so Windows can exercise the same realpath escape
    // defense via junctions even when the user lacks symlink privilege.
    const outsideTarget = join(outsideDir, "target");
    mkdirSync(outsideTarget);

    // Plant a symlink/junction inside the sandbox that points outside.
    const symlinkInside = join(sandboxCwd, "escape");
    symlinkSync(outsideTarget, symlinkInside, dirLinkType);

    // realpath follows the symlink → outside → denied.
    const result = validateSandboxPath(symlinkInside, sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
  });

  it("denies a relative path that traverses upward outside cwd", () => {
    // `../../../etc/passwd` resolves against process.cwd() by default.
    // We validate against sandboxCwd which is a fresh tempdir, so the
    // result is outside the boundary.
    const result = validateSandboxPath("../../../etc/passwd", sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
  });

  it("validates a non-existent path via nearest existing parent realpath", () => {
    // Path does not exist, but the absolute-path form is inside cwd → allowed.
    const phantom = join(sandboxCwd, "does-not-exist-yet", "file.txt");
    const result = validateSandboxPath(phantom, sandboxCwd);
    expect(result.allowed).toBe(true);
  });

  it("allows a non-existent path when cwd is reached through a symlink alias", () => {
    const alias = join(outsideDir, "sandbox-alias");
    symlinkSync(sandboxCwd, alias, dirLinkType);

    const phantom = join(alias, "generated", "file.txt");
    const result = validateSandboxPath(phantom, alias);
    expect(result.allowed).toBe(true);
  });

  it("blocks a non-existent path under an escaping symlink directory", () => {
    const outsideTarget = join(outsideDir, "target-dir");
    mkdirSync(outsideTarget);
    const symlinkInside = join(sandboxCwd, "escape-dir");
    symlinkSync(outsideTarget, symlinkInside, dirLinkType);

    const phantom = join(symlinkInside, "future.txt");
    const result = validateSandboxPath(phantom, sandboxCwd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside the sandbox boundary");
  });

  it("denies a non-existent path that resolves outside cwd", () => {
    const phantom = join(outsideDir, "also-does-not-exist.txt");
    const result = validateSandboxPath(phantom, sandboxCwd);
    expect(result.allowed).toBe(false);
  });

  it("does not crash with an empty extraAllowed array", () => {
    const inside = join(sandboxCwd, "file.txt");
    writeFileSync(inside, "x");
    expect(() => validateSandboxPath(inside, sandboxCwd, [])).not.toThrow();
    const result = validateSandboxPath(inside, sandboxCwd, []);
    expect(result.allowed).toBe(true);
  });

  it("treats the cwd itself as allowed (equal path)", () => {
    const result = validateSandboxPath(sandboxCwd, sandboxCwd);
    expect(result.allowed).toBe(true);
  });

  it("does not allow a sibling path that shares a name prefix", () => {
    // Ensure the `/` trailing-slash guard prevents
    // `/tmp/foo/abcd/...` from matching against `/tmp/foo/abc`.
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "lvis-prefix-")));
    cleanup.push(parent);
    const a = join(parent, "abc");
    const ab = join(parent, "abcd");
    mkdirSync(a);
    mkdirSync(ab);
    const fileInAb = join(ab, "f.txt");
    writeFileSync(fileInAb, "x");

    // Path inside `abcd` must NOT be considered within `abc`.
    const result = validateSandboxPath(fileInAb, a);
    expect(result.allowed).toBe(false);
  });
});
