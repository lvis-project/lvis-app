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

  it("plugin with dotted reverse-domain id (com.lge.xxx) and underscore methods loads correctly", async () => {
    // Plugin ID may use reverse-domain dots (package identity namespace)
    // Tool names (methods[]) must still be underscore-only (LLM tool name namespace)
    const pluginId = "com.lge.test";
    const pluginDir = join(installedDir, "com-lge-test");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: { "com_lge_test_hello": async () => "hi" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );

    const manifest = { id: pluginId, name: "Test", version: "1.0.0", entry: "entry.mjs", methods: ["com_lge_test_hello"] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeRegistry([{ id: pluginId, manifestPath, enabled: true }]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain(pluginId);
    expect(runtime.listMethods()).toContain("com_lge_test_hello");
  });

  it("plugin with dot-notation method name fails to load with a clear error", async () => {
    // Methods are LLM tool names and must not contain dots
    const pluginDir = join(installedDir, "bad-plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "bad.method": async () => "fail" } };
}
`,
      "utf-8",
    );

    const manifest = { id: "bad-plugin", name: "Bad", version: "1.0.0", entry: "entry.mjs", methods: ["bad.method"] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeRegistry([{ id: "bad-plugin", manifestPath, enabled: true }]);

    const runtime = makeRuntime();
    await expect(runtime.load()).rejects.toThrow(/Invalid tool name 'bad\.method'/);
  });

  it("exposes capability/manifest/ipc binding metadata from loaded plugins", async () => {
    const pluginDir = join(installedDir, "meta-plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "meta_ping": async () => "pong",
    },
  };
}
`,
      "utf-8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "meta-plugin",
        name: "meta-plugin",
        version: "1.0.0",
        entry: "entry.mjs",
        methods: ["meta_ping"],
        capabilities: ["meta-capability"],
        startupMethods: ["meta_ping"],
        ipcBindings: [
          {
            channel: "lvis:meta:ping",
            method: "meta_ping",
            args: ["message"],
          },
        ],
      }),
      "utf-8",
    );

    await writeRegistry([{ id: "meta-plugin", manifestPath, enabled: true }]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.findPluginIdByCapability("meta-capability")).toBe("meta-plugin");
    expect(runtime.listPluginIdsByCapability("meta-capability")).toEqual(["meta-plugin"]);

    const manifest = runtime.getPluginManifest("meta-plugin");
    expect(manifest?.startupMethods).toEqual(["meta_ping"]);

    expect(runtime.listIpcBindings()).toEqual([
      {
        pluginId: "meta-plugin",
        channel: "lvis:meta:ping",
        method: "meta_ping",
        args: ["message"],
      },
    ]);
  });
});
