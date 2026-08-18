/**
 * Unit tests for deriveSandboxWritePaths — the namespace-scoped OS sandbox
 * write-jail derivation. Pure logic: asserts the derived capability set
 * (union of owner plugin sandbox root + allowed directories, canonicalized
 * and de-duplicated) without invoking any OS sandbox primitive.
 */
import { afterEach, describe, it, expect } from "vitest";
import { join } from "node:path";
import { deriveSandboxWritePaths } from "../sandbox-write-jail.js";
import { canonicalizePathForMatch } from "../sensitive-paths.js";
import { PermissionTestResources } from "./test-resources.js";
import { resolvePluginWritableRoot } from "../../plugins/plugin-storage-layout.js";

const resources = new PermissionTestResources();

afterEach(async () => {
  await resources.cleanup();
});

describe("deriveSandboxWritePaths", () => {
  it("jails to the allowed directories when there is no owner plugin (builtin shell)", () => {
    const cwd = resources.makeTmpDir("lvis-jail-cwd-");
    const result = deriveSandboxWritePaths({ allowedDirectories: [cwd] });
    expect(result).toEqual([canonicalizePathForMatch(cwd)]);
  });

  it("includes the owner plugin sandbox root when the tool is plugin-owned", () => {
    const cwd = resources.makeTmpDir("lvis-jail-cwd-");
    const pluginRoot = resources.makeTmpDir("lvis-jail-plugin-");
    const result = deriveSandboxWritePaths({
      ownerPluginSandboxRoot: pluginRoot,
      allowedDirectories: [cwd],
    });
    expect(result).toContain(canonicalizePathForMatch(pluginRoot));
    expect(result).toContain(canonicalizePathForMatch(cwd));
    expect(result).toHaveLength(2);
  });

  it("unions the owner plugin root with all in-scope allowed directories", () => {
    const cwd = resources.makeTmpDir("lvis-jail-cwd-");
    const extra = resources.makeTmpDir("lvis-jail-extra-");
    const pluginRoot = resources.makeTmpDir("lvis-jail-plugin-");
    const result = deriveSandboxWritePaths({
      ownerPluginSandboxRoot: pluginRoot,
      allowedDirectories: [cwd, extra],
    });
    expect(new Set(result)).toEqual(
      new Set([
        canonicalizePathForMatch(pluginRoot),
        canonicalizePathForMatch(cwd),
        canonicalizePathForMatch(extra),
      ]),
    );
  });

  it("de-duplicates paths that canonicalize to the same location", () => {
    const cwd = resources.makeTmpDir("lvis-jail-cwd-");
    // Same dir passed twice (e.g. cwd also listed as an extra) collapses to one.
    const result = deriveSandboxWritePaths({ allowedDirectories: [cwd, cwd] });
    expect(result).toEqual([canonicalizePathForMatch(cwd)]);
  });

  it("does not treat the owner plugin root as writable when it is undefined", () => {
    const cwd = resources.makeTmpDir("lvis-jail-cwd-");
    const result = deriveSandboxWritePaths({
      ownerPluginSandboxRoot: undefined,
      allowedDirectories: [cwd],
    });
    expect(result).toEqual([canonicalizePathForMatch(cwd)]);
  });

  it("drops empty-string entries from both sources", () => {
    const cwd = resources.makeTmpDir("lvis-jail-cwd-");
    const result = deriveSandboxWritePaths({
      ownerPluginSandboxRoot: "",
      allowedDirectories: ["", cwd],
    });
    expect(result).toEqual([canonicalizePathForMatch(cwd)]);
  });

  it("returns an empty set when no writable region is supplied", () => {
    expect(deriveSandboxWritePaths({ allowedDirectories: [] })).toEqual([]);
  });

  it("canonicalizes paths (the OS jail and the reviewer see identical strings)", () => {
    const base = resources.makeTmpDir("lvis-jail-canon-");
    // A path with a redundant '.' segment must canonicalize to the same
    // string the reviewer's sensitive-path layer produces.
    const dotted = join(base, ".", "");
    const result = deriveSandboxWritePaths({ allowedDirectories: [dotted] });
    expect(result).toEqual([canonicalizePathForMatch(dotted)]);
    expect(result[0]).toBe(canonicalizePathForMatch(base));
  });

  it("does not admit the owner plugin's installed bundle into the write jail", () => {
    // Producers derive the owner root via resolvePluginWritableRoot, so the
    // jail covers `<pluginRoot>/data` only. `dist/` — the module the next load
    // imports into the Electron main process — stays outside it.
    const cwd = resources.makeTmpDir("lvis-jail-bundle-cwd-");
    const writableRoot = resolvePluginWritableRoot("lvis-plugin-jail-fixture");
    const result = deriveSandboxWritePaths({
      ownerPluginSandboxRoot: writableRoot,
      allowedDirectories: [cwd],
    });
    const pluginRoot = join(writableRoot, "..");
    expect(result).not.toContain(canonicalizePathForMatch(pluginRoot));
    expect(result).not.toContain(canonicalizePathForMatch(join(pluginRoot, "dist")));
  });
});
