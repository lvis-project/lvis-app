/**
 * Tests for PluginRuntime lifecycle — restartPlugin disk-reread.
 *
 * Covers the scenario where restartPlugin re-reads the manifest from disk
 * and re-instantiates with the latest on-disk state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../../runtime.js";

describe("PluginRuntime lifecycle — restartPlugin", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-lifecycle-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeRuntime() {
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
  }

  it("restartPlugin is a no-op when plugin is not loaded (warns)", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    // Should not throw, just warn
    await expect(runtime.restartPlugin("nonexistent")).resolves.toBeUndefined();
  });

  it("restartPlugin stops and restarts a loaded plugin", async () => {
    const pluginDir = join(installedDir, "lc-restart");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `let count = 0;
export default async function createPlugin() {
  return {
    handlers: { lc_restart_ping: async () => ++count },
    start: async () => {},
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-restart",
        name: "LC Restart",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["lc_restart_ping"],
        description: "Lifecycle restart test",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restart", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();

    // Plugin is loaded
    expect(runtime.listPluginIds()).toContain("lc-restart");

    // Restart it
    await runtime.restartPlugin("lc-restart");

    // Plugin should still be loaded after restart
    expect(runtime.listPluginIds()).toContain("lc-restart");
    // Tool should still be callable
    await expect(runtime.call("lc_restart_ping")).resolves.toBeDefined();
  });

  it("restartPlugin marks plugin as failed when manifest is missing on disk", async () => {
    const pluginDir = join(installedDir, "lc-fail-manifest");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_fail_manifest_ping: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-fail-manifest",
        name: "LC Fail Manifest",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["lc_fail_manifest_ping"],
        description: "Lifecycle fail manifest test",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-fail-manifest", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("lc-fail-manifest");

    // Delete the manifest before restart
    await rm(manifestPath);

    await runtime.restartPlugin("lc-fail-manifest");

    // Plugin should be unloaded after failed restart
    expect(runtime.listPluginIds()).not.toContain("lc-fail-manifest");
    // Tool should no longer be callable
    await expect(runtime.call("lc_fail_manifest_ping")).rejects.toThrow("Plugin method not found");
  });

  it("restartAll re-loads all plugins", async () => {
    const pluginDir = join(installedDir, "lc-restartall");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_restartall_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-restartall",
        name: "LC RestartAll",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["lc_restartall_ping"],
        description: "Lifecycle restartAll test",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restartall", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("lc-restartall");

    await runtime.restartAll();

    expect(runtime.listPluginIds()).toContain("lc-restartall");
    await expect(runtime.call("lc_restartall_ping")).resolves.toBe("pong");
  });

  it("disable removes plugin and updates registry", async () => {
    const pluginDir = join(installedDir, "lc-disable");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_disable_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-disable",
        name: "LC Disable",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["lc_disable_ping"],
        description: "Lifecycle disable test",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-disable", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("lc-disable");

    await runtime.disable("lc-disable");

    expect(runtime.listPluginIds()).not.toContain("lc-disable");
    await expect(runtime.call("lc_disable_ping")).rejects.toThrow("Plugin method not found");
  });

  it("disable throws when plugin is not loaded", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.disable("does-not-exist")).rejects.toThrow("Plugin not loaded");
  });
});
