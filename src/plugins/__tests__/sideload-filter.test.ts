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
  // A sibling directory outside tmpDir used as an escape target.
  // Created here so a real file exists on disk — realpathSync requires the
  // target to exist for a non-dangling symlink. Using tmpdir() siblings is
  // platform-neutral (avoids /etc/passwd which does not exist on Windows).
  let escapeTarget: string;

  beforeEach(async () => {
    const base = join(tmpdir(), `sideload-test-${process.pid}-${Date.now()}`);
    tmpDir = join(base, "install");
    escapeTarget = join(base, "outside-file.txt");
    await mkdir(tmpDir, { recursive: true });
    await writeFile(escapeTarget, "escape");
  });

  afterEach(async () => {
    await rm(join(tmpDir, ".."), { recursive: true, force: true });
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
    const escaping = join(tmpDir, "escape.txt");
    await symlink(escapeTarget, escaping);
    await expect(rejectEscapingSymlinks(tmpDir)).rejects.toThrow("symlink escapes install dir");
  });

  it("rejects nested symlinks in node_modules escaping installDir", async () => {
    const nmDir = join(tmpDir, "node_modules", "evil-pkg");
    await mkdir(nmDir, { recursive: true });
    await symlink(escapeTarget, join(nmDir, "index.js"));
    await expect(rejectEscapingSymlinks(tmpDir)).rejects.toThrow("symlink escapes install dir");
  });

  it("rejects dangling symlinks (target does not exist — unverifiable at install time)", async () => {
    const dangling = join(tmpDir, "dangling.js");
    await symlink(join(tmpDir, "nonexistent-target.js"), dangling);
    await expect(rejectEscapingSymlinks(tmpDir)).rejects.toThrow("unresolvable symlink");
  });

  it("throws for non-absolute dir argument", async () => {
    await expect(rejectEscapingSymlinks("relative/path")).rejects.toThrow("must be absolute");
  });
});
