import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSideloadCopyFilter, rejectSideloadSymlinks } from "../sideload-filter.js";

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

  /**
   * Thrown rather than filtered out. A developer whose source tree carries a
   * `data/` expected that state to be installed; dropping it silently would
   * leave them believing it was, and promoting it would put a second candidate
   * for the plugin's state into the root the swap carries the live one into.
   */
  it("refuses a top-level runtime directory in the source tree", () => {
    expect(() => filter(join(root, "data"))).toThrow(/top-level runtime directory/);
    expect(() => filter(join(root, "run"))).toThrow(/top-level runtime directory/);
    expect(() => filter(join(root, "sockets"))).toThrow(/top-level runtime directory/);
  });

  it("accepts the same names nested inside the payload", () => {
    expect(filter(join(root, "dist", "data"))).toBe(true);
    expect(filter(join(root, "database"))).toBe(true);
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

  // Without this, electron's filter leaves `.bin/electron` as a dangling
  // symlink and `rejectSideloadSymlinks` aborts the entire install.
  it("rejects node_modules/.bin shell-shim subtree", () => {
    expect(filter(join(root, "node_modules", ".bin"))).toBe(false);
    expect(filter(join(root, "node_modules", ".bin", "electron"))).toBe(false);
    expect(filter(join(root, "node_modules", ".bin", "tsc"))).toBe(false);
  });

  it("rejects monorepo-nested node_modules/.bin", () => {
    expect(filter(join(root, "packages", "child", "node_modules", ".bin", "electron"))).toBe(false);
    expect(filter(join(root, "packages", "child", "node_modules", ".bin", "tsc"))).toBe(false);
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
// rejectSideloadSymlinks
// ---------------------------------------------------------------------------

describe("rejectSideloadSymlinks", () => {
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
    await expect(rejectSideloadSymlinks(tmpDir)).resolves.toBeUndefined();
  });

  // Symlink creation on Windows requires elevated privileges — skip on that platform.
  const itSymlink = it.skipIf(process.platform === "win32");

  itSymlink("rejects an internal symlink before promotion", async () => {
    await writeFile(join(tmpDir, "real.js"), "");
    await symlink(join(tmpDir, "real.js"), join(tmpDir, "link.js"));
    await expect(rejectSideloadSymlinks(tmpDir)).rejects.toThrow(
      "symbolic link is not allowed in install dir: link.js",
    );
  });

  itSymlink("rejects a symlink whose target escapes installDir", async () => {
    const escaping = join(tmpDir, "escape.txt");
    await symlink(escapeTarget, escaping);
    await expect(rejectSideloadSymlinks(tmpDir)).rejects.toThrow(
      "symbolic link is not allowed in install dir: escape.txt",
    );
  });

  itSymlink("rejects nested symlinks in node_modules escaping installDir", async () => {
    const nmDir = join(tmpDir, "node_modules", "evil-pkg");
    await mkdir(nmDir, { recursive: true });
    await symlink(escapeTarget, join(nmDir, "index.js"));
    await expect(rejectSideloadSymlinks(tmpDir)).rejects.toThrow(
      "symbolic link is not allowed in install dir: node_modules/evil-pkg/index.js",
    );
  });

  itSymlink("rejects dangling symlinks", async () => {
    const dangling = join(tmpDir, "dangling.js");
    await symlink(join(tmpDir, "nonexistent-target.js"), dangling);
    await expect(rejectSideloadSymlinks(tmpDir)).rejects.toThrow(
      "symbolic link is not allowed in install dir: dangling.js",
    );
  });

  it("throws for non-absolute dir argument", async () => {
    await expect(rejectSideloadSymlinks("relative/path")).rejects.toThrow("must be absolute");
  });
});

// ---------------------------------------------------------------------------
// Integration: cp({ filter }) + rejectSideloadSymlinks against a fixture that
// mimics the ms-graph layout — proves the filter prevents the dangling-bin
// regression that motivated this PR. A future refactor that splits filter and
// walker would re-regress without this case.
// ---------------------------------------------------------------------------
describe("integration: cp filter + rejectSideloadSymlinks (ms-graph layout)", () => {
  let baseDir: string;
  let sourceDir: string;
  let stagingDir: string;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `sideload-integ-${process.pid}-${Date.now()}`);
    sourceDir = join(baseDir, "src-plugin");
    stagingDir = join(baseDir, "staging");
    await mkdir(sourceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const itSymlink = it.skipIf(process.platform === "win32");

  itSymlink("ms-graph fixture (electron pkg + .bin/electron shim) installs cleanly", async () => {
    // dist/ + plugin.json — the legitimate plugin payload.
    await mkdir(join(sourceDir, "dist"), { recursive: true });
    await writeFile(join(sourceDir, "dist", "hostPlugin.js"), "export default {};");
    await writeFile(join(sourceDir, "plugin.json"), '{"id":"x","name":"X","version":"1.0.0","tools":[],"entry":"dist/hostPlugin.js","description":"d"}');

    // node_modules/electron/cli.js + node_modules/.bin/electron -> ../electron/cli.js
    // (the exact shape that triggered the dangling-symlink rejection on
    // ms-graph after PR #404 + PR #407 landed).
    const electronPkg = join(sourceDir, "node_modules", "electron");
    await mkdir(electronPkg, { recursive: true });
    await writeFile(join(electronPkg, "cli.js"), "// electron cli");
    await mkdir(join(sourceDir, "node_modules", ".bin"), { recursive: true });
    await symlink("../electron/cli.js", join(sourceDir, "node_modules", ".bin", "electron"));

    // A non-electron .bin shim that ALSO would dangle without the .bin filter
    // (its target package is not present at all).
    await symlink("../never-existed/cli.js", join(sourceDir, "node_modules", ".bin", "phantom"));

    // Mirror the production install pipeline: cp with the sideload filter,
    // then run rejectSideloadSymlinks on the staged dir.
    const { cp } = await import("node:fs/promises");
    await cp(sourceDir, stagingDir, {
      recursive: true,
      verbatimSymlinks: true,
      filter: buildSideloadCopyFilter(sourceDir),
    });
    await expect(rejectSideloadSymlinks(stagingDir)).resolves.toBeUndefined();

    // Staging must contain plugin.json + dist/, but NOT electron / .bin.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(stagingDir, "plugin.json"))).toBe(true);
    expect(existsSync(join(stagingDir, "dist", "hostPlugin.js"))).toBe(true);
    expect(existsSync(join(stagingDir, "node_modules", "electron"))).toBe(false);
    expect(existsSync(join(stagingDir, "node_modules", ".bin"))).toBe(false);
  });
});
