/**
 * Unit tests for deriveSandboxWritePaths — the namespace-scoped OS sandbox
 * write-jail derivation. Pure logic: asserts the derived capability set
 * (union of owner plugin sandbox root + allowed directories, canonicalized
 * and de-duplicated) without invoking any OS sandbox primitive.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSandboxWritePaths } from "../sandbox-write-jail.js";
import { canonicalizePathForMatch } from "../sensitive-paths.js";

describe("deriveSandboxWritePaths", () => {
  it("jails to the allowed directories when there is no owner plugin (builtin shell)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lvis-jail-cwd-"));
    const result = deriveSandboxWritePaths({ allowedDirectories: [cwd] });
    expect(result).toEqual([canonicalizePathForMatch(cwd)]);
  });

  it("includes the owner plugin sandbox root when the tool is plugin-owned", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lvis-jail-cwd-"));
    const pluginRoot = mkdtempSync(join(tmpdir(), "lvis-jail-plugin-"));
    const result = deriveSandboxWritePaths({
      ownerPluginSandboxRoot: pluginRoot,
      allowedDirectories: [cwd],
    });
    expect(result).toContain(canonicalizePathForMatch(pluginRoot));
    expect(result).toContain(canonicalizePathForMatch(cwd));
    expect(result).toHaveLength(2);
  });

  it("unions the owner plugin root with all in-scope allowed directories", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lvis-jail-cwd-"));
    const extra = mkdtempSync(join(tmpdir(), "lvis-jail-extra-"));
    const pluginRoot = mkdtempSync(join(tmpdir(), "lvis-jail-plugin-"));
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
    const cwd = mkdtempSync(join(tmpdir(), "lvis-jail-cwd-"));
    // Same dir passed twice (e.g. cwd also listed as an extra) collapses to one.
    const result = deriveSandboxWritePaths({ allowedDirectories: [cwd, cwd] });
    expect(result).toEqual([canonicalizePathForMatch(cwd)]);
  });

  it("does not treat the owner plugin root as writable when it is undefined", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lvis-jail-cwd-"));
    const result = deriveSandboxWritePaths({
      ownerPluginSandboxRoot: undefined,
      allowedDirectories: [cwd],
    });
    expect(result).toEqual([canonicalizePathForMatch(cwd)]);
  });

  it("drops empty-string entries from both sources", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lvis-jail-cwd-"));
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
    const base = mkdtempSync(join(tmpdir(), "lvis-jail-canon-"));
    // A path with a redundant '.' segment must canonicalize to the same
    // string the reviewer's sensitive-path layer produces.
    const dotted = join(base, ".", "");
    const result = deriveSandboxWritePaths({ allowedDirectories: [dotted] });
    expect(result).toEqual([canonicalizePathForMatch(dotted)]);
    expect(result[0]).toBe(canonicalizePathForMatch(base));
  });
});
