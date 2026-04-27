import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";
import { mkdtempSync } from "node:fs";

describe("PluginRuntime config overrides", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-runtime-config-"));
    installedDir = join(testDir, "plugins", "installed");
    registryPath = join(testDir, "plugins", "registry.json");
    await mkdir(installedDir, { recursive: true });
    await mkdir(join(testDir, "plugins"), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("applies updated plugin config overrides after restartAll", async () => {
    const pluginDir = join(installedDir, "config-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "config_echo": async () => ctx.config.apiKey ?? "missing",
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
        id: "config-plugin",
        name: "Config Plugin",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["config_echo"],
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "config-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      configOverrides: {
        "config-plugin": { apiKey: "before" },
      },
    });

    await runtime.load();
    await expect(runtime.call("config_echo")).resolves.toBe("before");

    runtime.setConfigOverride("config-plugin", { apiKey: "after" });
    await runtime.restartAll();

    await expect(runtime.call("config_echo")).resolves.toBe("after");
  });

  it("fires onDisable for loaded plugins before restartAll re-registers them", async () => {
    const pluginDir = join(installedDir, "cleanup-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: {
      "cleanup_echo": async () => "ok",
    },
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "cleanup-plugin",
        name: "Cleanup Plugin",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["cleanup_echo"],
        keywords: [{ keyword: "cleanup", skillId: "cleanup_echo" }],
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "cleanup-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const events: string[] = [];
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      onDisable: (pluginId) => events.push(`disable:${pluginId}`),
      createHostApi: (pluginId) => ({
        registerKeywords: () => {
          events.push(`register:${pluginId}`);
        },
      }),
    });

    await runtime.load();
    events.length = 0;
    await runtime.restartAll();

    expect(events).toEqual(["disable:cleanup-plugin", "register:cleanup-plugin"]);
    await expect(runtime.call("cleanup_echo")).resolves.toBe("ok");
  });
});
