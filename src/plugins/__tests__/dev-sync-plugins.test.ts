/**
 * Unit tests for scripts/dev-sync-plugins.mjs — the developer plugin
 * sync workflow that replaces the legacy dev-link symlink path.
 *
 * The script itself runs at `bun run dev` time and operates on the
 * sibling lvis-plugin-* repos + `~/.lvis/plugins/`. We can't drive the
 * full workflow in vitest (it scans the actual workspace) but we can
 * import its pure helpers and assert the behaviours that matter for
 * trust-boundary correctness.
 */
import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The .mjs script exports the pure helpers we want to verify. Importing
// it here also asserts the script is parseable and side-effect-free at
// import time when run outside the workspace.
//
// Vite resolves the .mjs through node's normal module loader.
import {
  buildCopyFilter,
  buildDevRegistryEntry,
  buildUpdatedRegistryDocument,
  copyManifestEntryFromContainedSource,
  copyFileAsRealFile,
  countEntries,
  isSafePluginId,
  isSafeRelativeManifestEntry,
  resolveContainedManifestEntry,
  isDevRegistryEntry,
  normalizePreservedNonDevRegistryEntry,
  removeAny,
  neutralizeLegacyInstallDirSymlink,
} from "../../../scripts/dev-sync-plugins.mjs";

describe("dev-sync-plugins — isSafePluginId", () => {
  it("accepts safe ids", () => {
    expect(isSafePluginId("agent-hub")).toBe(true);
    expect(isSafePluginId("com.lge.sample")).toBe(true);
    expect(isSafePluginId("ms_graph")).toBe(true);
    expect(isSafePluginId("pageindex")).toBe(true);
    expect(isSafePluginId("com.lge.sample_v2")).toBe(true);
    expect(isSafePluginId("9plugin")).toBe(true);
    expect(isSafePluginId("agent..hub")).toBe(true);
    expect(isSafePluginId("agent--hub")).toBe(true);
    expect(isSafePluginId("agent__hub")).toBe(true);
    expect(isSafePluginId("agent-hub.")).toBe(true);
  });
  it("rejects path-traversal, separators, and blank/ambiguous ids", () => {
    expect(isSafePluginId(".")).toBe(false);
    expect(isSafePluginId("..")).toBe(false);
    expect(isSafePluginId("../escape")).toBe(false);
    expect(isSafePluginId("evil/../x")).toBe(false);
    expect(isSafePluginId("evil\\x")).toBe(false);
    expect(isSafePluginId(" with-space")).toBe(false);
    expect(isSafePluginId("with space")).toBe(false);
    expect(isSafePluginId("   ")).toBe(false);
    expect(isSafePluginId("")).toBe(false);
    expect(isSafePluginId(undefined as unknown as string)).toBe(false);
  });
});

describe("dev-sync-plugins — isSafeRelativeManifestEntry", () => {
  it("accepts ordinary relative entry paths", () => {
    expect(isSafeRelativeManifestEntry("dist/index.js")).toBe(true);
    expect(isSafeRelativeManifestEntry("dist/nested/index.js")).toBe(true);
    expect(isSafeRelativeManifestEntry("dist")).toBe(true);
  });

  it("rejects absolute, dot-segment, and escaping manifest.entry paths", () => {
    expect(isSafeRelativeManifestEntry("")).toBe(false);
    expect(isSafeRelativeManifestEntry("   ")).toBe(false);
    expect(isSafeRelativeManifestEntry("/abs/index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("./dist/index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("dist/./index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("dist//index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("dist\\index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("\\\\server\\share\\index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("C:\\\\plugin\\\\index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("../dist/index.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("dist/../../escape.js")).toBe(false);
    expect(isSafeRelativeManifestEntry("dist\\..\\escape.js")).toBe(false);
    expect(isSafeRelativeManifestEntry(".")).toBe(false);
  });
});

describe("dev-sync-plugins — resolveContainedManifestEntry", () => {
  const pluginRepoDir = join(tmpdir(), "dev-sync-manifest-entry-root");

  it("rejects absolute manifest.entry paths", () => {
    expect(resolveContainedManifestEntry(pluginRepoDir, "/abs/index.js")).toBeNull();
  });

  it("rejects traversal manifest.entry paths", () => {
    expect(resolveContainedManifestEntry(pluginRepoDir, "../dist/index.js")).toBeNull();
  });

  it("rejects dot-segment manifest.entry paths before resolution", () => {
    expect(resolveContainedManifestEntry(pluginRepoDir, "./dist/index.js")).toBeNull();
    expect(resolveContainedManifestEntry(pluginRepoDir, "dist/./index.js")).toBeNull();
  });

  it("rejects backslash-separated manifest.entry paths before resolution", () => {
    expect(resolveContainedManifestEntry(pluginRepoDir, "dist\\index.js")).toBeNull();
  });

  it("rejects Windows drive manifest.entry paths", () => {
    expect(resolveContainedManifestEntry(pluginRepoDir, "C:\\plugin\\index.js")).toBeNull();
  });

  it("rejects UNC manifest.entry paths", () => {
    expect(resolveContainedManifestEntry(pluginRepoDir, "\\\\server\\share\\index.js")).toBeNull();
  });

  it("resolves a safe relative manifest.entry inside the plugin repo", () => {
    expect(resolveContainedManifestEntry(pluginRepoDir, "dist/index.js")).toBe(
      join(pluginRepoDir, "dist", "index.js"),
    );
  });
});

describe("dev-sync-plugins — copyManifestEntryFromContainedSource", () => {
  it("copies a safe contained manifest.entry outside dist as a real file", () => {
    const root = join(
      tmpdir(),
      `dev-sync-entry-copy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const pluginRepoDir = join(root, "repo");
    const installDir = join(root, "install");
    const sourceEntry = join(pluginRepoDir, "build", "entry.js");
    const destEntry = join(installDir, "build", "entry.js");

    try {
      mkdirSync(join(pluginRepoDir, "build"), { recursive: true });
      writeFileSync(sourceEntry, "export default 1;\n", "utf-8");

      copyManifestEntryFromContainedSource(sourceEntry, destEntry);

      expect(readFileSync(destEntry, "utf-8")).toBe("export default 1;\n");
      expect(lstatSync(destEntry).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dev-sync-plugins — buildCopyFilter", () => {
  it("excludes electron / @electron / .bin / .git when constructed with repo root", () => {
    const root = "/tmp/plugin";
    const filter = buildCopyFilter(root);
    expect(filter("/tmp/plugin/.git/HEAD")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/electron/cli.js")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/@electron/remote/index.js")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/.bin/tsc")).toBe(false);
  });
  it("includes ordinary plugin files when constructed with repo root", () => {
    const root = "/tmp/plugin";
    const filter = buildCopyFilter(root);
    expect(filter("/tmp/plugin/dist/index.js")).toBe(true);
    expect(filter("/tmp/plugin/plugin.json")).toBe(true);
    expect(filter("/tmp/plugin/node_modules/lodash/index.js")).toBe(true);
  });

  // Robustness: the filter must also work if a future caller hands it the
  // node_modules/ directory as the source root. Earlier the filter assumed
  // a node_modules segment somewhere in the relative path; that broke when
  // sourceRoot was node_modules itself (the segment never appears in rel).
  it("excludes electron / @electron / .bin when constructed with node_modules root", () => {
    const root = "/tmp/plugin/node_modules";
    const filter = buildCopyFilter(root);
    expect(filter("/tmp/plugin/node_modules/electron/cli.js")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/@electron/remote/index.js")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/.bin/tsc")).toBe(false);
    expect(filter("/tmp/plugin/node_modules/lodash/index.js")).toBe(true);
  });

  // Integration regression for Copilot review on PR #466: prove the filter
  // actually excludes electron during a real cpSync(), not just at the
  // unit level. We synthesize <repo>/node_modules/{electron,lodash} and
  // run cpSync exactly as scripts/dev-sync-plugins.mjs does.
  it("integrates with cpSync to physically skip electron and materialise symlinked deps", async () => {
    const { cpSync } = await import("node:fs");
    const repoRoot = join(
      tmpdir(),
      `dev-sync-cpSync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const nmSrc = join(repoRoot, "node_modules");
    const nmDest = join(repoRoot, "_install", "node_modules");
    try {
      mkdirSync(join(nmSrc, "electron"), { recursive: true });
      writeFileSync(join(nmSrc, "electron", "cli.js"), "// electron", "utf-8");
      mkdirSync(join(nmSrc, "@electron", "remote"), { recursive: true });
      writeFileSync(join(nmSrc, "@electron", "remote", "index.js"), "// @electron", "utf-8");
      mkdirSync(join(nmSrc, ".bin"), { recursive: true });
      writeFileSync(join(nmSrc, ".bin", "tsc"), "#!/bin/sh\n", "utf-8");
      mkdirSync(join(nmSrc, "lodash"), { recursive: true });
      writeFileSync(join(nmSrc, "lodash", "index.js"), "// lodash", "utf-8");
      mkdirSync(join(repoRoot, "shared"), { recursive: true });
      writeFileSync(join(repoRoot, "shared", "shared.js"), "// shared", "utf-8");
      symlinkSync(join(repoRoot, "shared"), join(nmSrc, "linked-pkg"), "dir");

      // Same call shape used by dev-sync-plugins.mjs after the fix:
      // filter is constructed with the *repo root*, copy goes node_modules → dest.
      cpSync(nmSrc, nmDest, {
        recursive: true,
        dereference: true,
        filter: buildCopyFilter(repoRoot),
      });

      expect(existsSync(join(nmDest, "lodash", "index.js"))).toBe(true);
      expect(existsSync(join(nmDest, "linked-pkg", "shared.js"))).toBe(true);
      expect(lstatSync(join(nmDest, "linked-pkg")).isSymbolicLink()).toBe(false);
      expect(existsSync(join(nmDest, "electron"))).toBe(false);
      expect(existsSync(join(nmDest, "@electron"))).toBe(false);
      expect(existsSync(join(nmDest, ".bin"))).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("dev-sync-plugins — registry helpers", () => {
  it("builds dev registry entries with canonical installSource only", () => {
    const entry = buildDevRegistryEntry("com.example.dev", {
      installPolicy: "admin",
      pluginAccess: { plugins: [{ pluginId: "ms-graph" }] },
    } as {
      installPolicy?: string;
      pluginAccess?: unknown;
    });

    expect(entry).toEqual({
      id: "com.example.dev",
      manifestPath: "com.example.dev/plugin.json",
      enabled: true,
      installSource: "dev",
      approvedPluginAccess: { plugins: [{ pluginId: "ms-graph" }] },
    });
    expect(entry).not.toHaveProperty("installedBy");
  });

  it("treats only canonical/legacy dev markers as dev entries", () => {
    expect(isDevRegistryEntry({ installSource: "dev" })).toBe(true);
    expect(isDevRegistryEntry({ installSource: "dev-link" })).toBe(true);
    expect(isDevRegistryEntry({ _devLinked: true })).toBe(true);
    expect(isDevRegistryEntry({ installSource: "user", _devLinked: true })).toBe(false);
    expect(isDevRegistryEntry({ installSource: "admin", _devLinked: true })).toBe(false);
  });

  it("preserves non-dev entries while stripping cleanup-only _devLinked", () => {
    expect(
      normalizePreservedNonDevRegistryEntry({
        id: "pageindex",
        manifestPath: "pageindex/plugin.json",
        installSource: "user",
        _devLinked: true,
      }),
    ).toEqual({
      id: "pageindex",
      manifestPath: "pageindex/plugin.json",
      installSource: "user",
    });

    expect(
      normalizePreservedNonDevRegistryEntry({
        id: "agent-hub",
        manifestPath: "agent-hub/plugin.json",
        installSource: "dev",
      }),
    ).toBeNull();
  });

  it("keeps canonical installSource while stripping stale `_devLinked` deterministically", () => {
    expect(
      normalizePreservedNonDevRegistryEntry({
        id: "calendar",
        manifestPath: "calendar/plugin.json",
        installSource: "user",
        enabled: true,
        _devLinked: true,
      }),
    ).toEqual({
      id: "calendar",
      manifestPath: "calendar/plugin.json",
      installSource: "user",
      enabled: true,
    });
  });

  it("preserves existing registry version and metadata when rewriting plugins", () => {
    expect(
      buildUpdatedRegistryDocument(
        {
          version: 7,
          updatedAt: "2026-05-02T00:00:00.000Z",
          plugins: [{ id: "old-dev", manifestPath: "old-dev/plugin.json", installSource: "dev" }],
        },
        [{ id: "user-plugin", manifestPath: "user-plugin/plugin.json", installSource: "user" }],
      ),
    ).toEqual({
      version: 7,
      updatedAt: "2026-05-02T00:00:00.000Z",
      plugins: [{ id: "user-plugin", manifestPath: "user-plugin/plugin.json", installSource: "user" }],
    });
  });

  it("defaults missing registry version to 1 when creating a rewritten document", () => {
    expect(
      buildUpdatedRegistryDocument(
        { plugins: [{ id: "stale", manifestPath: "stale/plugin.json" }] },
        [{ id: "fresh", manifestPath: "fresh/plugin.json", installSource: "dev" }],
      ),
    ).toEqual({
      version: 1,
      plugins: [{ id: "fresh", manifestPath: "fresh/plugin.json", installSource: "dev" }],
    });
  });
});

describe("dev-sync-plugins — removeAny", () => {
  // The migration story: a user with the legacy `dev:link` workflow has
  // ~/.lvis/plugins/<id>/plugin.json as a symlink AND ~/.lvis/plugins/<id>/dist
  // as a symlink. The new dev:sync script must wipe these symlinks before
  // copying real files, otherwise cpSync would either follow the symlink
  // (writing into the workspace!) or fail. removeAny is the function that
  // performs that wipe — it must be idempotent and handle three states:
  // missing, symlink, real file/dir.
  it("removes a symlink without touching the target", () => {
    const dir = join(tmpdir(), `dev-sync-removeAny-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "real");
    const linkPath = join(dir, "link");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep me", "utf-8");
    symlinkSync(target, linkPath, "dir");

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    removeAny(linkPath);
    expect(existsSync(linkPath)).toBe(false);
    // The symlink target must be untouched — this is the crucial property
    // for migration: we must NEVER blow away the workspace plugin repo.
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, "marker"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });
  it("removes a real directory", () => {
    const dir = join(tmpdir(), `dev-sync-removeAny-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const realDir = join(dir, "rdir");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "f.txt"), "x", "utf-8");

    removeAny(realDir);
    expect(existsSync(realDir)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
  it("is a no-op for missing paths", () => {
    expect(() => removeAny(join(tmpdir(), `nonexistent-${Math.random()}`))).not.toThrow();
  });
});

describe("dev-sync-plugins — copyFileAsRealFile", () => {
  it("materializes a symlinked manifest as a real file in the install tree", () => {
    const root = join(
      tmpdir(),
      `dev-sync-copy-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspaceDir = join(root, "workspace");
    const installDir = join(root, "install");
    const realManifest = join(workspaceDir, "plugin.real.json");
    const symlinkedManifest = join(workspaceDir, "plugin.json");
    const installedManifest = join(installDir, "plugin.json");
    try {
      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(installDir, { recursive: true });
      writeFileSync(realManifest, '{"id":"com.example.copy-only"}', "utf-8");
      symlinkSync(realManifest, symlinkedManifest, "file");

      copyFileAsRealFile(symlinkedManifest, installedManifest);

      expect(existsSync(installedManifest)).toBe(true);
      expect(lstatSync(installedManifest).isSymbolicLink()).toBe(false);
      expect(readFileSync(installedManifest, "utf-8")).toBe('{"id":"com.example.copy-only"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dev-sync-plugins — neutralizeLegacyInstallDirSymlink", () => {
  // Critical safety regression for Copilot review on PR #466.
  //
  // Legacy layout: ~/.lvis/plugins/<id> is itself a symlink that points at
  // the developer's workspace (e.g. ~/workspace/lvis-plugin-foo). Without a
  // guard, the dev-sync script would call removeAny(installDir/dist) which
  // resolves through the symlink and deletes <workspace>/dist — destroying
  // the developer's repo contents.
  //
  // After the fix, neutralizeLegacyInstallDirSymlink() detects the symlink
  // and unlinks it BEFORE any child-path mutation. The workspace target
  // must remain pristine.
  it("unlinks a symlinked installDir without touching the workspace target", () => {
    const root = join(
      tmpdir(),
      `dev-sync-symlink-installdir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const workspace = join(root, "workspace", "lvis-plugin-foo");
    const userPluginsRoot = join(root, ".lvis", "plugins");
    const installDir = join(userPluginsRoot, "com.example.foo");
    try {
      // Workspace contents the developer must NOT lose
      mkdirSync(join(workspace, "dist"), { recursive: true });
      writeFileSync(join(workspace, "dist", "index.js"), "// real source", "utf-8");
      writeFileSync(join(workspace, "plugin.json"), '{"id":"com.example.foo"}', "utf-8");
      mkdirSync(userPluginsRoot, { recursive: true });
      // Legacy: installDir IS a symlink to the workspace
      symlinkSync(workspace, installDir, "dir");
      expect(lstatSync(installDir).isSymbolicLink()).toBe(true);

      const wasLegacy = neutralizeLegacyInstallDirSymlink(installDir);

      expect(wasLegacy).toBe(true);
      expect(existsSync(installDir)).toBe(false);
      // Workspace must be entirely untouched.
      expect(existsSync(join(workspace, "dist", "index.js"))).toBe(true);
      expect(existsSync(join(workspace, "plugin.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false and leaves a real install directory alone", () => {
    const root = join(
      tmpdir(),
      `dev-sync-real-installdir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const installDir = join(root, "com.example.real");
    try {
      mkdirSync(installDir, { recursive: true });
      // Sibling plugin data file — must be preserved across neutralize.
      writeFileSync(join(installDir, "data.json"), '{"k":"v"}', "utf-8");

      const wasLegacy = neutralizeLegacyInstallDirSymlink(installDir);

      expect(wasLegacy).toBe(false);
      expect(existsSync(installDir)).toBe(true);
      expect(existsSync(join(installDir, "data.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns false for a missing path (no-op)", () => {
    expect(
      neutralizeLegacyInstallDirSymlink(join(tmpdir(), `nonexistent-${Math.random()}`)),
    ).toBe(false);
  });
});

describe("dev-sync-plugins — countEntries", () => {
  it("counts nested files and directories without Node 20 recursive readdir support", () => {
    const root = join(
      tmpdir(),
      `dev-sync-countEntries-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      mkdirSync(join(root, "dist", "nested"), { recursive: true });
      writeFileSync(join(root, "plugin.json"), "{}", "utf-8");
      writeFileSync(join(root, "dist", "index.js"), "// entry", "utf-8");
      writeFileSync(join(root, "dist", "nested", "chunk.js"), "// chunk", "utf-8");

      expect(countEntries(root)).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
