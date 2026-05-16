/**
 * plugin-paths SoT helper.
 *
 * Locks the layout (rooted at `lvisHome()/plugins/`) and the registry-relative
 * manifestPath helper used by every marketplace install path.
 *
 * Env override removed. Tests now exercise constructor injection only
 * (the sole remaining override mechanism).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { resolvePluginPaths, toRegistryRelativeManifestPath } from "../plugin-paths.js";
import { setIsPackaged, _resetForTest as resetDevFlags } from "../../boot/dev-flags.js";
import { lvisHome } from "../../shared/lvis-home.js";

describe("resolvePluginPaths", () => {
  beforeEach(() => {
    setIsPackaged(false);
  });
  afterEach(() => {
    resetDevFlags();
  });

  it("defaults pluginsRoot to lvisHome()/plugins/ with registry + cache derived under it", () => {
    const paths = resolvePluginPaths();
    const expected = resolve(lvisHome(), "plugins");
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

  it("constructor-injected pluginsRoot redirects pluginsRoot + cache + registry", () => {
    // This replaces the previous LVIS_PLUGINS_DIR env-override test.
    // Tests / portable installs / CI sandbox isolation pass an
    // explicit `pluginsRoot` instead of relying on env var resolution.
    const paths = resolvePluginPaths({ pluginsRoot: "/tmp/portable" });
    expect(paths.pluginsRoot).toBe(resolve("/tmp/portable"));
    expect(paths.registryPath).toBe(resolve("/tmp/portable", "registry.json"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/portable", ".cache"));
  });

  it("constructor-injected pluginsRoot is honored even on packaged builds", () => {
    // There is no env hard-gate to bypass anymore. Constructor injection is
    // the only override path and it works regardless of
    // packaged-mode (the input value is trusted because it came from
    // boot-process code, not a user-controllable env var).
    setIsPackaged(true);
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

  it("explicit cacheRoot is independent of pluginsRoot", () => {
    const paths = resolvePluginPaths({
      pluginsRoot: "/tmp/p",
      cacheRoot: "/tmp/explicit-cache",
    });
    expect(paths.pluginsRoot).toBe(resolve("/tmp/p"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/explicit-cache"));
  });

  it("packaged build with no input falls back to canonical homedir layout", () => {
    setIsPackaged(true);
    const paths = resolvePluginPaths();
    expect(paths.pluginsRoot).toBe(resolve(lvisHome(), "plugins"));
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
