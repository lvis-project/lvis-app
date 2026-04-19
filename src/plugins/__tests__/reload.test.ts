import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";

/**
 * I2 — PluginRuntime.reloadPlugin() unit tests.
 *
 * Uses a real tmp-dir fixture with a minimal ESM plugin entry so we exercise
 * the full stop → re-import → start path (not mocks). Module-cache bust via
 * `?reload=<ts>` query string is verified by rewriting the entry between
 * loads and observing the new handler response.
 */
describe("PluginRuntime.reloadPlugin", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `lvis-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, version: string): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "${methodName}": async () => "v-${version}",
    },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [methodName],
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writeRegistry(entries: Array<{ id: string; manifestPath: string }>): Promise<void> {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: entries.map((e) => ({ ...e, enabled: true })) }),
      "utf-8",
    );
  }

  it("reload re-imports fresh bundle and re-registers handlers", async () => {
    const manifestPath = await writePlugin("p-reload", "a");
    await writeRegistry([{ id: "p-reload", manifestPath }]);

    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath });
    await runtime.load();

    expect(await runtime.call("p_reload_hello")).toBe("v-a");

    // Rewrite entry — simulate bun run build producing new dist output.
    const pluginDir = join(installedDir, "p-reload");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "p_reload_hello": async () => "v-b",
    },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );

    await runtime.reloadPlugin("p-reload");

    // Method handler must still be registered AND return the new bundle's value.
    expect(runtime.listToolNames()).toContain("p_reload_hello");
    expect(await runtime.call("p_reload_hello")).toBe("v-b");
  });

  it("reload fires onDisable hook for host-side cleanup", async () => {
    const manifestPath = await writePlugin("p-hook", "a");
    await writeRegistry([{ id: "p-hook", manifestPath }]);

    const disabled: string[] = [];
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      onDisable: (id) => disabled.push(id),
    });
    await runtime.load();

    await runtime.reloadPlugin("p-hook");

    expect(disabled).toEqual(["p-hook"]);
    // After reload the plugin is re-loaded so call() still works.
    expect(runtime.listPluginIds()).toContain("p-hook");
  });

  it("reload on unknown plugin throws", async () => {
    await writeRegistry([]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath });
    await runtime.load();
    await expect(runtime.reloadPlugin("missing")).rejects.toThrow(/not loaded/);
  });

  it("getPluginEntryDir returns dist directory for loaded plugin", async () => {
    const manifestPath = await writePlugin("p-dir", "a");
    await writeRegistry([{ id: "p-dir", manifestPath }]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath });
    await runtime.load();
    const dir = runtime.getPluginEntryDir("p-dir");
    expect(dir).toBe(join(installedDir, "p-dir"));
    expect(runtime.getPluginEntryDir("missing")).toBeUndefined();
  });
});
