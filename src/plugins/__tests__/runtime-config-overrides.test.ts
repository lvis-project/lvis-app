import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

describe("PluginRuntime config overrides", () => {
  let fixture: TestPluginRuntimeFixture;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "lvis-runtime-config-" });
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
  });

  async function installConfigPlugin(input: {
    id: string;
    tool: string;
    entrySource: string;
    manifest?: Record<string, unknown>;
  }): Promise<void> {
    const { manifestPath } = await writeTestPlugin(fixture, {
      id: input.id,
      tools: [input.tool],
      entrySource: input.entrySource,
      manifest: {
        name: input.id,
        ...input.manifest,
      },
    });
    await writeTestPluginRegistry(fixture, [
      { id: input.id, manifestPath, enabled: true },
    ]);
  }

  it("applies updated plugin config overrides after restartAll", async () => {
    await installConfigPlugin({
      id: "config-plugin",
      tool: "config_echo",
      entrySource: `export default async function createPlugin(ctx) {
  return { handlers: { "config_echo": async () => ctx.config.apiKey ?? "missing" } };
}
`,
      manifest: { name: "Config Plugin" },
    });

    const runtime = makeTestPluginRuntime(
      fixture,
      {
        configOverrides: {
          "config-plugin": { apiKey: "before" },
        },
      },
    );

    await runtime.startAll();
    await expect(runtime.call("config_echo")).resolves.toBe("before");

    runtime.setConfigOverride("config-plugin", { apiKey: "after" });
    await runtime.restartAll();

    await expect(runtime.call("config_echo")).resolves.toBe("after");
  });

  it("clears plugin-specific config overrides on removePlugin", async () => {
    await installConfigPlugin({
      id: "remove-config-plugin",
      tool: "remove_config_echo",
      entrySource: `export default async function createPlugin(ctx) {
  return { handlers: { "remove_config_echo": async () => ctx.config.apiKey ?? "missing" } };
}
`,
      manifest: { name: "Remove Config Plugin" },
    });

    const runtime = makeTestPluginRuntime(
      fixture,
      {
        configOverrides: {
          "remove-config-plugin": { apiKey: "stale" },
        },
      },
    );

    await runtime.startAll();
    await expect(runtime.call("remove_config_echo")).resolves.toBe("stale");

    await runtime.removePlugin("remove-config-plugin");
    await runtime.addPlugin("remove-config-plugin");

    await expect(runtime.call("remove_config_echo")).resolves.toBe("missing");
  });

  it("fires onDisable for loaded plugins before restartAll re-registers them", async () => {
    await installConfigPlugin({
      id: "cleanup-plugin",
      tool: "cleanup_echo",
      entrySource: `export default async function createPlugin() {
  return {
    handlers: {
      "cleanup_echo": async () => "ok",
    },
    stop: async () => {},
  };
}
`,
      manifest: {
        name: "Cleanup Plugin",
        keywords: [{ keyword: "cleanup", skillId: "cleanup_echo" }],
      },
    });

    const events: string[] = [];
    const runtime = makeTestPluginRuntime(fixture, {
      onDisable: (pluginId) => events.push(`disable:${pluginId}`),
      createHostApi: (pluginId) => ({
        registerKeywords: () => {
          events.push(`register:${pluginId}`);
        },
      }),
    });

    await runtime.startAll();
    events.length = 0;
    await runtime.restartAll();

    expect(events).toEqual(["disable:cleanup-plugin", "register:cleanup-plugin"]);
    await expect(runtime.call("cleanup_echo")).resolves.toBe("ok");
  });

  it("backfills configSchema defaults when neither manifest.config nor overrides set the key", async () => {
    await installConfigPlugin({
      id: "schema-default-plugin",
      tool: "schema_default_echo",
      entrySource: `export default async function createPlugin(ctx) {
  return { handlers: { "schema_default_echo": async () => ctx.config.hubServerUrl ?? "MISSING" } };
}
`,
      manifest: {
        name: "Schema Default Plugin",
        description: "Verifies host backfills configSchema.default.",
        configSchema: {
          properties: {
            hubServerUrl: {
              type: "string",
              default: "https://example.test",
            },
          },
        },
      },
    });
    // No override for schema-default-plugin — handler must see the
    // schema-declared default, not undefined. Reproduces the agent-hub
    // 404 regression where `${cfg.hubServerUrl}${path}` produced
    // `undefined/api/v1/me` because configSchema defaults weren't
    // applied at sandbox-context build time.
    const runtime = makeTestPluginRuntime(fixture, {
      configOverrides: {},
    });
    await runtime.startAll();
    await expect(runtime.call("schema_default_echo")).resolves.toBe(
      "https://example.test",
    );
  });

  it("plugin-specific override wins over configSchema default", async () => {
    await installConfigPlugin({
      id: "override-wins-plugin",
      tool: "override_wins_echo",
      entrySource: `export default async function createPlugin(ctx) {
  return { handlers: { "override_wins_echo": async () => ctx.config.hubServerUrl } };
}
`,
      manifest: {
        name: "Override Wins Plugin",
        description: "Verifies override > configSchema default.",
        configSchema: {
          properties: {
            hubServerUrl: {
              type: "string",
              default: "https://default.test",
            },
          },
        },
      },
    });
    const runtime = makeTestPluginRuntime(fixture, {
      configOverrides: {
        "override-wins-plugin": { hubServerUrl: "https://override.test" },
      },
    });
    await runtime.startAll();
    await expect(runtime.call("override_wins_echo")).resolves.toBe(
      "https://override.test",
    );
  });
});
