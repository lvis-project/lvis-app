/**
 * Phase 0 — plugin-paths SoT helper.
 *
 * Behaviour locked here so future phase 2 path moves don't accidentally
 * reshuffle the layout that consumers (boot, marketplace, deployment-guard)
 * already depend on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolvePluginPaths } from "../plugin-paths.js";

describe("resolvePluginPaths", () => {
  const originalEnv = process.env.LVIS_PLUGINS_DIR;
  beforeEach(() => {
    delete process.env.LVIS_PLUGINS_DIR;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LVIS_PLUGINS_DIR;
    } else {
      process.env.LVIS_PLUGINS_DIR = originalEnv;
    }
  });

  it("preserves the legacy default layout when nothing is overridden", () => {
    const paths = resolvePluginPaths({ appRoot: "/tmp/appA" });
    expect(paths.registryPath).toBe(resolve("/tmp/appA", "plugins/registry.json"));
    expect(paths.marketplacePath).toBe(resolve("/tmp/appA", "plugins/marketplace.json"));
    expect(paths.userInstalledDir).toBe(resolve(homedir(), ".lvis/plugins"));
    expect(paths.cacheRoot).toBe(resolve(homedir(), ".lvis/plugins/.cache"));
  });

  it("honors the LVIS_PLUGINS_DIR env override for user installs", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/custom-plugins";
    const paths = resolvePluginPaths({ appRoot: "/tmp/appA" });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/custom-plugins"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/custom-plugins/.cache"));
    // Registry/marketplace stay tied to appRoot — unaffected by env override.
    expect(paths.registryPath).toBe(resolve("/tmp/appA", "plugins/registry.json"));
  });

  it("explicit userInstalledDir wins over env override", () => {
    process.env.LVIS_PLUGINS_DIR = "/tmp/env-plugins";
    const paths = resolvePluginPaths({
      appRoot: "/tmp/appA",
      userInstalledDir: "/tmp/explicit",
    });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/explicit"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/explicit/.cache"));
  });

  it("explicit cacheRoot can decouple cache from userInstalledDir", () => {
    const paths = resolvePluginPaths({
      appRoot: "/tmp/appA",
      userInstalledDir: "/tmp/u",
      cacheRoot: "/tmp/cache",
    });
    expect(paths.userInstalledDir).toBe(resolve("/tmp/u"));
    expect(paths.cacheRoot).toBe(resolve("/tmp/cache"));
  });
});
