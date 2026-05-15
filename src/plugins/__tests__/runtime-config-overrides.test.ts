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
        description: "Test fixture.",
        publisher: "Test fixture",
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
      pluginsRoot: installedDir,
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

  it("clears plugin-specific config overrides on removePlugin", async () => {
    const pluginDir = join(installedDir, "remove-config-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "remove_config_echo": async () => ctx.config.apiKey ?? "missing",
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
        id: "remove-config-plugin",
        name: "Remove Config Plugin",
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: ["remove_config_echo"],
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "remove-config-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      configOverrides: {
        "remove-config-plugin": { apiKey: "stale" },
      },
    });

    await runtime.load();
    await expect(runtime.call("remove_config_echo")).resolves.toBe("stale");

    await runtime.removePlugin("remove-config-plugin");
    await runtime.addPlugin("remove-config-plugin");

    await expect(runtime.call("remove_config_echo")).resolves.toBe("missing");
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
        description: "Test fixture.",
        publisher: "Test fixture",
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
      pluginsRoot: installedDir,
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

  it("backfills configSchema defaults when neither manifest.config nor overrides set the key", async () => {
    const pluginDir = join(installedDir, "schema-default-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "schema_default_echo": async () => ctx.config.hubServerUrl ?? "MISSING",
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
        id: "schema-default-plugin",
        name: "Schema Default Plugin",
        version: "1.0.0",
        description: "Verifies host backfills configSchema.default.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: ["schema_default_echo"],
        configSchema: {
          properties: {
            hubServerUrl: {
              type: "string",
              default: "https://example.test",
            },
          },
        },
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "schema-default-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    // No override for schema-default-plugin — handler must see the
    // schema-declared default, not undefined. Reproduces the agent-hub
    // 404 regression where `${cfg.hubServerUrl}${path}` produced
    // `undefined/api/v1/me` because configSchema defaults weren't
    // applied at sandbox-context build time.
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      configOverrides: {},
    });
    await runtime.load();
    await expect(runtime.call("schema_default_echo")).resolves.toBe(
      "https://example.test",
    );
  });

  it("plugin-specific override wins over configSchema default", async () => {
    const pluginDir = join(installedDir, "override-wins-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "override_wins_echo": async () => ctx.config.hubServerUrl,
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
        id: "override-wins-plugin",
        name: "Override Wins Plugin",
        version: "1.0.0",
        description: "Verifies override > configSchema default.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: ["override_wins_echo"],
        configSchema: {
          properties: {
            hubServerUrl: {
              type: "string",
              default: "https://default.test",
            },
          },
        },
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "override-wins-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      configOverrides: {
        "override-wins-plugin": { hubServerUrl: "https://override.test" },
      },
    });
    await runtime.load();
    await expect(runtime.call("override_wins_echo")).resolves.toBe(
      "https://override.test",
    );
  });
});
