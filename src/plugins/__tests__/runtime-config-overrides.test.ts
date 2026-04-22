import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";

describe("PluginRuntime config overrides", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-runtime-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    const stopMarker = join(testDir, "config-plugin.stopped");
    const disabled: string[] = [];
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "config_echo": async () => ctx.config.apiKey ?? "missing",
    },
    async stop() {
      await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(stopMarker)}, "stopped", "utf-8"));
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
      onDisable: (pluginId) => disabled.push(pluginId),
    });

    await runtime.load();
    await expect(runtime.call("config_echo")).resolves.toBe("before");

    runtime.setConfigOverride("config-plugin", { apiKey: "after" });
    await runtime.restartAll();

    await expect(import("node:fs/promises").then((fs) => fs.readFile(stopMarker, "utf-8"))).resolves.toBe("stopped");
    expect(disabled).toEqual(["config-plugin"]);
    await expect(runtime.call("config_echo")).resolves.toBe("after");
  });
});
