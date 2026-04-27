/**
 * plugin-paths SoT helper.
 *
 * Locks the layout (rooted at `~/.lvis/plugins/`) and the registry-relative
 * manifestPath helper used by every marketplace install path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { resolvePluginPaths, toRegistryRelativeManifestPath } from "../plugin-paths.js";
import { setIsPackaged, _resetForTest as resetDevFlags } from "../../boot/dev-flags.js";

describe("resolvePluginPaths", () => {
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

  it("defaults pluginsRoot to ~/.lvis/plugins/ with registry + cache derived under it", () => {
    const paths = resolvePluginPaths();
    const expected = resolve(homedir(), ".lvis", "plugins");
    expect(paths.pluginsRoot).toBe(expected);
    expect(paths.registryPath).toBe(resolve(expected, "registry.json"));
    expect(paths.cacheRoot).toBe(resolve(expected, ".cache"));
  });

  it("explicit pluginsRoot wins over the homedir default", () => {
    const paths = resolvePluginPaths({ pluginsRoot: "/tmp/explicit" });
    expect(paths.pluginsRoot).toBe(resolve("/tmp/explicit"));
    expect(paths.registryPath).toBe(resolve("/tmp/explicit", "registry.json"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/explicit", ".cache"));
  });

  it("LVIS_PLUGINS_DIR env override redirects pluginsRoot + cache + registry on dev builds", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/portable";
    const paths = resolvePluginPaths();
    expect(paths.pluginsRoot).toBe(resolve("/tmp/portable"));
    expect(paths.registryPath).toBe(resolve("/tmp/portable", "registry.json"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/portable", ".cache"));
  });

  it("explicit pluginsRoot wins over env override", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/env";
    const paths = resolvePluginPaths({ pluginsRoot: "/tmp/explicit" });
    expect(paths.pluginsRoot).toBe(resolve("/tmp/explicit"));
  });

  it("explicit cacheRoot can decouple cache from pluginsRoot", () => {
    const paths = resolvePluginPaths({
      pluginsRoot: "/tmp/u",
      cacheRoot: "/tmp/cache",
    });
    expect(paths.pluginsRoot).toBe(resolve("/tmp/u"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/cache"));
  });

  it("env override does not displace an explicit cacheRoot", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/env";
    const paths = resolvePluginPaths({ cacheRoot: "/tmp/explicit-cache" });
    expect(paths.pluginsRoot).toBe(resolve("/tmp/env"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/explicit-cache"));
  });

  it("packaged build silently ignores LVIS_PLUGINS_DIR env override", () => {
    // Hard-gate: a packaged binary that inherits this env var must fall back
    // to the canonical layout, never the user-controlled override path.
    setIsPackaged(true);
    process.env.LVIS_PLUGINS_DIR = "/tmp/attacker-controlled";
    const paths = resolvePluginPaths();
    expect(paths.pluginsRoot).toBe(resolve(homedir(), ".lvis", "plugins"));
  });
});

describe("toRegistryRelativeManifestPath", () => {
  it("returns POSIX-relative path for manifest under registry's directory", () => {
    const out = toRegistryRelativeManifestPath(
      "/lvis/plugins/registry.json",
      "/lvis/plugins/calendar/plugin.json",
    );
    expect(out).toBe("calendar/plugin.json");
  });

  it("collapses already-relative input back to relative form", () => {
    const out = toRegistryRelativeManifestPath(
      "/lvis/plugins/registry.json",
      "calendar/plugin.json",
    );
    expect(out).toBe("calendar/plugin.json");
  });

  it("output never contains backslashes (POSIX separators only)", () => {
    const out = toRegistryRelativeManifestPath(
      "/lvis/plugins/registry.json",
      "/lvis/plugins/email/plugin.json",
    );
    expect(out).not.toContain("\\");
  });

  it("returns absolute path verbatim when manifest is outside registry tree", () => {
    // Runtime trust-root rejects these — production install must always be
    // under pluginsRoot. Helper only normalizes; it does not enforce.
    const out = toRegistryRelativeManifestPath(
      "/lvis/plugins/registry.json",
      "/Users/dev/legacy/plugin.json",
    );
    expect(out).toMatch(/legacy\/plugin\.json$/);
  });
});
