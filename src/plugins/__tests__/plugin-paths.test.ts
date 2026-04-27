/**
 * Phase 2a — plugin-paths SoT helper.
 *
 * Locks the new layout (rooted at userDataDir, no `<appRoot>/plugins/`
 * fallback) and the registry-relative manifestPath helper used by every
 * marketplace install path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { resolvePluginPaths, toRegistryRelativeManifestPath } from "../plugin-paths.js";
import { setIsPackaged, _resetForTest as resetDevFlags } from "../../boot/dev-flags.js";

describe("resolvePluginPaths (Phase 2a)", () => {
  const originalEnv = process.env.LVIS_PLUGINS_DIR;
  beforeEach(() => {
    delete process.env.LVIS_PLUGINS_DIR;
    // dev-flags defaults to packaged-mode (env override ignored). The override
    // is dev-only — every test in this block runs under unpackaged-mode unless
    // it explicitly flips back.
    setIsPackaged(false);
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LVIS_PLUGINS_DIR;
    } else {
      process.env.LVIS_PLUGINS_DIR = originalEnv;
    }
    resetDevFlags();
  });

  it("anchors registry/installed/cache at userDataDir/plugins", () => {
    const paths = resolvePluginPaths({ userDataDir: "/tmp/userData" });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/userData", "plugins"));
    expect(paths.registryPath).toBe(resolve("/tmp/userData", "plugins/registry.json"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/userData", "plugins/.cache"));
  });

  it("throws when userDataDir is missing — no legacy fallback", () => {
    // @ts-expect-error — intentionally invalid input for runtime check
    expect(() => resolvePluginPaths({})).toThrow(/userDataDir is required/);
  });

  it("registry path always sits inside userInstalledDir (Phase 2a invariant)", () => {
    const paths = resolvePluginPaths({
      userDataDir: "/tmp/userData",
      userInstalledDir: "/tmp/explicit",
    });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/explicit"));
    expect(paths.registryPath).toBe(resolve("/tmp/explicit", "registry.json"));
  });

  it("LVIS_PLUGINS_DIR env override redirects userInstalledDir + cache + registry", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/portable";
    const paths = resolvePluginPaths({ userDataDir: "/tmp/userData" });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/portable"));
    expect(paths.registryPath).toBe(resolve("/tmp/portable", "registry.json"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/portable", ".cache"));
  });

  it("explicit userInstalledDir wins over env override", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/env";
    const paths = resolvePluginPaths({
      userDataDir: "/tmp/userData",
      userInstalledDir: "/tmp/explicit",
    });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/explicit"));
  });

  it("explicit cacheRoot can decouple cache from userInstalledDir", () => {
    const paths = resolvePluginPaths({
      userDataDir: "/tmp/userData",
      userInstalledDir: "/tmp/u",
      cacheRoot: "/tmp/cache",
    });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/u"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/cache"));
  });

  it("env override does not displace an explicit cacheRoot", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/env";
    const paths = resolvePluginPaths({
      userDataDir: "/tmp/userData",
      cacheRoot: "/tmp/explicit-cache",
    });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/env"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/explicit-cache"));
  });

  it("packaged build silently ignores LVIS_PLUGINS_DIR env override", () => {
    // Hard-gate: a packaged binary that inherits this env var must fall back
    // to the canonical userData/plugins layout, never the user-controlled
    // override path.
    setIsPackaged(true);
    process.env.LVIS_PLUGINS_DIR = "/tmp/attacker-controlled";
    const paths = resolvePluginPaths({ userDataDir: "/tmp/userData" });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/userData", "plugins"));
  });
});

describe("toRegistryRelativeManifestPath", () => {
  it("returns POSIX-relative path for manifest under registry's directory", () => {
    const out = toRegistryRelativeManifestPath(
      "/userData/plugins/registry.json",
      "/userData/plugins/calendar/plugin.json",
    );
    expect(out).toBe("calendar/plugin.json");
  });

  it("collapses already-relative input back to relative form", () => {
    const out = toRegistryRelativeManifestPath(
      "/userData/plugins/registry.json",
      "calendar/plugin.json",
    );
    expect(out).toBe("calendar/plugin.json");
  });

  it("output never contains backslashes (POSIX separators only)", () => {
    const out = toRegistryRelativeManifestPath(
      "/userData/plugins/registry.json",
      "/userData/plugins/email/plugin.json",
    );
    expect(out).not.toContain("\\");
  });

  it("returns absolute path verbatim when manifest is outside registry tree", () => {
    // Phase 2c migration shim rejects these — production install must always
    // be under userInstalledDir. Helper only normalizes; it does not enforce.
    const out = toRegistryRelativeManifestPath(
      "/userData/plugins/registry.json",
      "/Users/dev/legacy/plugin.json",
    );
    expect(out).toMatch(/legacy\/plugin\.json$/);
  });
});
