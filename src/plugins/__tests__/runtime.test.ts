import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";

/**
 * Phase 1.5 F-round §F5: direct unit tests for `PluginRuntime.disable()`.
 * Uses a real tmp-dir fixture with a minimal ESM plugin entry so the full
 * load → disable path is exercised (not mocks).
 */
describe("PluginRuntime.disable", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `lvis-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeFakePlugin(
    id: string,
    deployment?: "managed" | "user",
  ): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });

    // Minimal ESM plugin entry — no external deps.
    const entryPath = join(pluginDir, "entry.mjs");
    await writeFile(
      entryPath,
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "${id}_hello": async () => "hi-${id}",
    },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );

    const manifest: Record<string, unknown> = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      methods: [`${id}_hello`],
    };
    if (deployment) manifest.deployment = deployment;
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writeRegistry(
    entries: Array<{ id: string; manifestPath: string; enabled?: boolean }>,
  ): Promise<void> {
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: entries }),
      "utf-8",
    );
  }

  function makeRuntime(): PluginRuntime {
    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      deploymentGuard: guard,
    });
  }

  it("disable removes methods + marks registry enabled=false for user plugin", async () => {
    const manifestPath = await writeFakePlugin("p-user");
    await writeRegistry([{ id: "p-user", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-user");
    expect(runtime.listMethods()).toContain("p-user_hello");

    await runtime.disable("p-user");

    expect(runtime.listPluginIds()).not.toContain("p-user");
    expect(runtime.listMethods()).not.toContain("p-user_hello");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find((p: { id: string }) => p.id === "p-user");
    expect(entry.enabled).toBe(false);
  });

  it("disable rejects managed plugin with guard error and leaves state unchanged", async () => {
    const manifestPath = await writeFakePlugin("p-managed", "managed");
    await writeRegistry([{ id: "p-managed", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await expect(runtime.disable("p-managed", "user")).rejects.toThrow(/Managed plugin/);

    expect(runtime.listPluginIds()).toContain("p-managed");
    expect(runtime.listMethods()).toContain("p-managed_hello");

    // registry should NOT have enabled=false
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find((p: { id: string }) => p.id === "p-managed");
    expect(entry.enabled).toBe(true);
  });

  it("disable allows it-admin actor to disable a managed plugin", async () => {
    const manifestPath = await writeFakePlugin("p-managed", "managed");
    await writeRegistry([{ id: "p-managed", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await runtime.disable("p-managed", "it-admin");

    expect(runtime.listPluginIds()).not.toContain("p-managed");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find((p: { id: string }) => p.id === "p-managed");
    expect(entry.enabled).toBe(false);
  });

  it("disable throws 'not found' for unknown pluginId without mutating state", async () => {
    const manifestPath = await writeFakePlugin("p-existing");
    await writeRegistry([{ id: "p-existing", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await expect(runtime.disable("p-missing")).rejects.toThrow(/not found/i);

    // Existing plugin still loaded
    expect(runtime.listPluginIds()).toContain("p-existing");
  });
});
