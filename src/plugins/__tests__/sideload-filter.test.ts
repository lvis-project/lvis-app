import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSideloadCopyFilter, rejectEscapingSymlinks } from "../sideload-filter.js";

// ---------------------------------------------------------------------------
// buildSideloadCopyFilter
// ---------------------------------------------------------------------------

describe("buildSideloadCopyFilter", () => {
  const root = "/fake/source";
  const filter = buildSideloadCopyFilter(root);

  it("accepts the root itself", () => {
    expect(filter(root)).toBe(true);
  });

  it("accepts regular source files", () => {
    expect(filter(join(root, "dist", "index.js"))).toBe(true);
    expect(filter(join(root, "plugin.json"))).toBe(true);
  });

  it("rejects top-level node_modules/electron", () => {
    expect(filter(join(root, "node_modules", "electron"))).toBe(false);
  });

  it("rejects monorepo-nested node_modules/electron", () => {
    expect(filter(join(root, "packages", "foo", "node_modules", "electron", "index.js"))).toBe(false);
  });

  it("rejects node_modules/@electron scoped packages", () => {
    expect(filter(join(root, "node_modules", "@electron", "asar"))).toBe(false);
  });

  it("accepts unrelated node_modules packages", () => {
    expect(filter(join(root, "node_modules", "node-ical", "index.js"))).toBe(true);
  });

  it("rejects .git directory", () => {
    expect(filter(join(root, ".git"))).toBe(false);
    expect(filter(join(root, ".git", "HEAD"))).toBe(false);
  });

  it("accepts .gitignore (not a .git directory)", () => {
    expect(filter(join(root, ".gitignore"))).toBe(true);
  });

  it("handles Windows-style backslash paths", () => {
    // Simulate a path with backslashes as separators
    const winFilter = buildSideloadCopyFilter("C:\\fake\\source");
    expect(winFilter("C:\\fake\\source\\node_modules\\electron\\dist")).toBe(false);
    expect(winFilter("C:\\fake\\source\\node_modules\\react\\index.js")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rejectEscapingSymlinks
// ---------------------------------------------------------------------------

describe("rejectEscapingSymlinks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `sideload-test-${process.pid}-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes for a directory with no symlinks", async () => {
    await mkdir(join(tmpDir, "dist"), { recursive: true });
    await writeFile(join(tmpDir, "plugin.json"), "{}");
    await expect(rejectEscapingSymlinks(tmpDir)).resolves.toBeUndefined();
  });

  it("passes for internal symlinks (target within installDir)", async () => {
    await writeFile(join(tmpDir, "real.js"), "");
    await symlink(join(tmpDir, "real.js"), join(tmpDir, "link.js"));
    await expect(rejectEscapingSymlinks(tmpDir)).resolves.toBeUndefined();
  });

  it("rejects a symlink whose target escapes installDir", async () => {
    // Use a within-tmpDir target that doesn't exist to create an escaping symlink
    // without relying on /etc/passwd (unavailable on Windows).
    const outsideTarget = join(tmpdir(), "outside-file.txt");
    await writeFile(outsideTarget, "");
    const escaping = join(tmpDir, "escape.txt");
    await symlink(outsideTarget, escaping);
    try {
      await expect(rejectEscapingSymlinks(tmpDir)).rejects.toThrow("symlink escapes install dir");
    } finally {
      await rm(outsideTarget, { force: true });
    }
  });

  it("rejects nested symlinks in node_modules escaping installDir", async () => {
    const outsideTarget = join(tmpdir(), "outside-nm.txt");
    await writeFile(outsideTarget, "");
    const nmDir = join(tmpDir, "node_modules", "evil-pkg");
    await mkdir(nmDir, { recursive: true });
    await symlink(outsideTarget, join(nmDir, "index.js"));
    try {
      await expect(rejectEscapingSymlinks(tmpDir)).rejects.toThrow("symlink escapes install dir");
    } finally {
      await rm(outsideTarget, { force: true });
    }
  });

  it("rejects dangling symlinks (target does not exist)", async () => {
    const dangling = join(tmpDir, "dangling.js");
    await symlink(join(tmpDir, "nonexistent.js"), dangling);
    await expect(rejectEscapingSymlinks(tmpDir)).rejects.toThrow("unresolvable symlink");
  });

  it("throws for non-absolute dir argument", async () => {
    await expect(rejectEscapingSymlinks("relative/path")).rejects.toThrow("must be absolute");
  });
});
