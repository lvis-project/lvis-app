/**
 * Tests for PluginRuntime lifecycle — restartPlugin disk-reread.
 *
 * Covers the scenario where restartPlugin re-reads the manifest from disk
 * and re-instantiates with the latest on-disk state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoopHostApiForTests, PluginRuntime } from "../../runtime.js";
import { buildImportUrl } from "../sandbox.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { PluginLoopbackManager } from "../../../mcp/plugin-loopback-manager.js";
import { makeTestPluginRuntime } from "../../__tests__/test-helpers.js";

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
    return makeTestPluginRuntime({
      rootDir: testDir,
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
        tools: [{ name: "lc_restart_ping", description: "lc_restart_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
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

  it("does not commit a replacement that finishes after removePlugin invalidates it", async () => {
    const pluginDir = join(installedDir, "lc-restart-remove-race");
    const armPath = join(testDir, "restart-arm");
    const enteredPath = join(testDir, "restart-entered");
    const releasePath = join(testDir, "restart-release");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { access, writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { lc_restart_remove_race_ping: async () => "pong" },
    start: async () => {
      try {
        await access(${JSON.stringify(armPath)});
        await writeFile(${JSON.stringify(enteredPath)}, "entered");
        while (true) {
          try { await access(${JSON.stringify(releasePath)}); break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
        }
      } catch {}
    },
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-restart-remove-race",
        name: "Restart Remove Race",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_restart_remove_race_ping", description: "restart removal race regression tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Lifecycle race regression",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restart-remove-race", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    await writeFile(armPath, "armed", "utf-8");
    const restart = runtime.restartPlugin("lc-restart-remove-race");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { await access(enteredPath); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    }
    await expect(access(enteredPath)).resolves.toBeUndefined();

    const removal = runtime.removePlugin("lc-restart-remove-race");
    await writeFile(releasePath, "release", "utf-8");

    await expect(restart).resolves.toBe("failed");
    await expect(removal).resolves.toBeUndefined();
    expect(runtime.listPluginIds()).not.toContain("lc-restart-remove-race");
    await expect(runtime.call("lc_restart_remove_race_ping")).rejects.toThrow(/not found/);
  });

  it("bounds an uncertain replacement start and fail-closes the old instance", async () => {
    const pluginDir = join(installedDir, "lc-restart-timeout");
    const armPath = join(testDir, "restart-timeout-arm");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { access } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { lc_restart_timeout_ping: async () => "old-still-live" },
    start: async () => {
      try {
        await access(${JSON.stringify(armPath)});
        await new Promise(() => {});
      } catch {}
    },
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-restart-timeout",
        name: "Restart Timeout",
        version: "1.0.0",
        entry: "entry.mjs",
        startupTimeoutMs: 50,
        tools: [{
          name: "lc_restart_timeout_ping",
          description: "Restart timeout regression tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        }],
        description: "Lifecycle restart timeout regression.",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restart-timeout", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    await writeFile(armPath, "armed", "utf-8");

    await expect(runtime.restartPlugin("lc-restart-timeout")).resolves.toBe("failed");
    expect(runtime.listPluginIds()).not.toContain("lc-restart-timeout");
    await expect(runtime.call("lc_restart_timeout_ping")).rejects.toThrow(/not found/);
    await expect(runtime.restartPlugin("lc-restart-timeout")).rejects.toMatchObject({
      code: "plugin-lifecycle-quarantined",
    });
  });

  it("revokes and unadvertises the old instance when its stop hook times out", async () => {
    const pluginDir = join(installedDir, "lc-stop-timeout");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: { lc_stop_timeout_ping: async () => "pong" },
    stop: async () => new Promise(() => {}),
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-stop-timeout",
        name: "Stop Timeout",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{
          name: "lc_stop_timeout_ping",
          description: "stop timeout regression tool",
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model", "app"] } },
        }],
        description: "Stop timeout regression.",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-stop-timeout", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.call("lc_stop_timeout_ping")).resolves.toBe("pong");

    await expect(runtime.restartPlugin("lc-stop-timeout")).resolves.toBe("failed");

    expect(runtime.listPluginIds()).not.toContain("lc-stop-timeout");
    await expect(runtime.call("lc_stop_timeout_ping")).rejects.toThrow(/failed|not found/i);
    await expect(runtime.restartPlugin("lc-stop-timeout")).rejects.toMatchObject({
      code: "plugin-lifecycle-quarantined",
    });
  }, 10_000);

  it("restartPlugin re-imports the latest on-disk module (ESM cache-bust)", async () => {
    // 회귀 가드: Node ESM 로더는 import URL 로 모듈을 메모이즈하므로,
    // `?reload=<ts>` 쿼리 없이 같은 file:// URL 을 다시 import 하면 옛
    // 모듈 그래프가 그대로 반환된다. 결과적으로 사용자가 플러그인을
    // 재설치하거나 config.set 으로 재시작 시켜도 옛 코드가 계속 동작.
    // (실제 PR 발견 경로: ms-graph 의 loginInExternalBrowser 토글이
    // 재설치 후에도 적용 안 되던 root cause 의 절반.)
    const pluginDir = join(installedDir, "lc-bust");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    const entryPath = join(pluginDir, "entry.mjs");

    await writeFile(
      entryPath,
      `export default async function createPlugin() {
  return {
    handlers: { lc_bust_version: async () => "v1" },
    start: async () => {},
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-bust",
        name: "LC Cache Bust",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_bust_version", description: "lc_bust_version tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "Cache-bust regression test",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-bust", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.call("lc_bust_version")).resolves.toBe("v1");

    // Overwrite the entry with a NEW module body. Without cache-bust the
    // restartPlugin re-import returns the cached "v1" module — failing
    // this assertion.
    await writeFile(
      entryPath,
      `export default async function createPlugin() {
  return {
    handlers: { lc_bust_version: async () => "v2" },
    start: async () => {},
    stop: async () => {},
  };
}`,
      "utf-8",
    );

    await runtime.restartPlugin("lc-bust");
    await expect(runtime.call("lc_bust_version")).resolves.toBe("v2");
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
        tools: [{ name: "lc_fail_manifest_ping", description: "lc_fail_manifest_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
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

    // Failed restart preserves the previously running instance.
    expect(runtime.listPluginIds()).toContain("lc-fail-manifest");
    await expect(runtime.call("lc_fail_manifest_ping")).resolves.toBe("ok");
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
        tools: [{ name: "lc_restartall_ping", description: "lc_restartall_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
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
        tools: [{ name: "lc_disable_ping", description: "lc_disable_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
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

  // Lifecycle callback contract: every post-boot transition into the
  // `loaded + started` state must fire `onEnable` so the host can re-sync
  // ToolRegistry, mirroring the existing `onDisable` tear-down hook.
  // Without `onEnable` the bug from PR #760 returns — `onDisable` wipes
  // plugin tools from ToolRegistry during the stop phase but nothing
  // re-registers them after start.
  async function setupLifecyclePluginFixture(pluginId: string) {
    const pluginDir = join(installedDir, pluginId);
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { ${pluginId.replace(/-/g, "_")}_ping: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: `${pluginId.replace(/-/g, "_")}_ping`, description: "lifecycle ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "x",
        publisher: "x",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    return manifestPath;
  }

  async function writeLifecyclePlugin(pluginId: string): Promise<{ pluginId: string; manifestPath: string; toolName: string }> {
    const pluginDir = join(installedDir, pluginId);
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    const toolName = `${pluginId.replace(/-/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { ${toolName}: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [
          {
            name: toolName,
            description: "lifecycle integration test",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "x",
        publisher: "x",
      }),
      "utf-8",
    );
    return { pluginId, manifestPath, toolName };
  }

  async function writeLifecycleRegistry(
    plugins: Array<{ pluginId: string; manifestPath: string }>,
  ): Promise<void> {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: plugins.map(({ pluginId, manifestPath }) => ({ id: pluginId, manifestPath, enabled: true })),
      }),
      "utf-8",
    );
  }

  it("restartAll fires onEnable once for each restarted plugin", async () => {
    const alpha = await writeLifecyclePlugin("lc-fanout-alpha");
    const beta = await writeLifecyclePlugin("lc-fanout-beta");
    await writeLifecycleRegistry([alpha, beta]);

    const enabled: string[] = [];
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onEnable: (pluginId) => { enabled.push(pluginId); },
    });

    await runtime.startAll();
    expect(enabled).toEqual([]);

    await runtime.restartAll();

    expect([...enabled].sort()).toEqual(["lc-fanout-alpha", "lc-fanout-beta"]);
  });

  it("restartPlugin fires onDisable then onEnable around the restart cycle", async () => {
    await setupLifecyclePluginFixture("lc-restart-pair");

    const events: Array<{ type: "disable" | "enable"; pluginId: string }> = [];
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (pluginId) => { events.push({ type: "disable", pluginId }); },
      onEnable: (pluginId) => { events.push({ type: "enable", pluginId }); },
    });
    await runtime.startAll();
    events.length = 0;

    await runtime.restartPlugin("lc-restart-pair");

    expect(events).toEqual([
      { type: "disable", pluginId: "lc-restart-pair" },
      { type: "enable", pluginId: "lc-restart-pair" },
    ]);
    await expect(runtime.call("lc_restart_pair_ping")).resolves.toBe("ok");
  });

  it("addPlugin (fresh-load branch) fires onEnable once after start succeeds", async () => {
    // Register the plugin in the registry but DO NOT call startAll — addPlugin
    // takes the fresh-load branch via instantiateAndStartSinglePlugin only
    // when the plugin is not already in the runtime's plugins map.
    await setupLifecyclePluginFixture("lc-add-fresh");

    const enableCalls: string[] = [];
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onEnable: (pluginId) => { enableCalls.push(pluginId); },
    });
    // Skip startAll so the plugins map stays empty — addPlugin's "already
    // loaded" branch (which delegates to restartPlugin) does not engage and
    // we exercise the fresh-load codepath in `instantiateAndStartSinglePlugin`.
    await runtime.addPlugin("lc-add-fresh");

    expect(enableCalls).toEqual(["lc-add-fresh"]);
    await expect(runtime.call("lc_add_fresh_ping")).resolves.toBe("ok");
  });

  it("reloadPlugin fires onEnable after a successful module re-import + start", async () => {
    await setupLifecyclePluginFixture("lc-reload-pair");

    const events: Array<{ type: "disable" | "enable"; pluginId: string }> = [];
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (pluginId) => { events.push({ type: "disable", pluginId }); },
      onEnable: (pluginId) => { events.push({ type: "enable", pluginId }); },
    });
    await runtime.startAll();
    events.length = 0;

    await runtime.reloadPlugin("lc-reload-pair");

    expect(events).toEqual([
      { type: "disable", pluginId: "lc-reload-pair" },
      { type: "enable", pluginId: "lc-reload-pair" },
    ]);
  });

  // Boot-wiring integration test: real PluginRuntime + real ToolRegistry +
  // a real `onEnable -> syncPluginToolRegistryForPlugin` callback. Asserts that
  // restartPlugin's `onEnable` actually re-populates ToolRegistry end-to-end,
  // not just that the callback was called (the other lifecycle tests assert
  // the callback contract; this one pins the boot WIRING that turns the
  // callback into a registry resync). If anyone removes the `onEnable`
  // wiring from `src/boot/steps/plugin-runtime.ts`, this test fails.
  it("boot wiring: onEnable → targeted ToolRegistry sync re-registers tools after restartPlugin", async () => {
    const pluginId = "lc-bootwiring";
    const toolName = "lc_bootwiring_ping";
    const pluginDir = join(installedDir, pluginId);
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { ${toolName}: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [
          {
            name: toolName,
            description: "lifecycle integration test",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
        description: "x",
        publisher: "x",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const toolRegistry = new ToolRegistry();
    // Mirror the production boot wiring: registration goes through the loopback
    // manager (legacy-removal flag-day). onEnable's start is async, so the test
    // tracks the last start promise to await it deterministically.
    let runtime!: PluginRuntime;
    let loopbackManager!: PluginLoopbackManager;
    let lastEnable: Promise<unknown> = Promise.resolve();
    runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (id) => { lastEnable = loopbackManager.stop(id); },
      onEnable: (id) => {
        const m = runtime.getPluginManifest(id);
        if (m) lastEnable = loopbackManager.start(m);
      },
    });
    loopbackManager = new PluginLoopbackManager(runtime, toolRegistry);
    await runtime.startAll();

    // Boot's `loopbackManager.syncAll(...)` initially populates the registry.
    await loopbackManager.syncAll(runtime.listPluginManifests());
    expect(toolRegistry.findByName(toolName)?.pluginId).toBe(pluginId);

    // Restart removes the tool via onDisable (manager.stop), then re-registers
    // via onEnable (manager.start). Without the wiring this test fails.
    await runtime.restartPlugin(pluginId);
    await lastEnable;

    expect(toolRegistry.findByName(toolName)?.pluginId).toBe(pluginId);
  });

  it("config-save restart path preserves bystander plugin tools", async () => {
    const alpha = await writeLifecyclePlugin("lc-config-alpha");
    const beta = await writeLifecyclePlugin("lc-config-beta");
    await writeLifecycleRegistry([alpha, beta]);

    const toolRegistry = new ToolRegistry();
    let runtime!: PluginRuntime;
    let loopbackManager!: PluginLoopbackManager;
    let lastEnable: Promise<unknown> = Promise.resolve();
    runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (id) => { lastEnable = loopbackManager.stop(id); },
      onEnable: (id) => {
        const m = runtime.getPluginManifest(id);
        if (m) lastEnable = loopbackManager.start(m);
      },
    });
    loopbackManager = new PluginLoopbackManager(runtime, toolRegistry);
    await runtime.startAll();
    await loopbackManager.syncAll(runtime.listPluginManifests());
    const betaBefore = toolRegistry.findByName(beta.toolName);
    expect(betaBefore?.pluginId).toBe(beta.pluginId);

    runtime.setConfigOverride(alpha.pluginId, { mode: "after-save" });
    await runtime.restartPlugin(alpha.pluginId);
    await lastEnable;

    expect(toolRegistry.findByName(alpha.toolName)?.pluginId).toBe(alpha.pluginId);
    expect(toolRegistry.findByName(beta.toolName)).toBe(betaBefore);
  });

  it("addPlugin failure path (start throws) does NOT fire onEnable", async () => {
    // Plugin whose `start` always throws — `instantiateAndStartSinglePlugin`
    // markFailed-and-returns on the catch branch, never reaches the
    // `this.onEnable?.(manifest.id)` call after the try/catch.
    const pluginId = "lc-add-fail";
    const pluginDir = join(installedDir, pluginId);
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: { lc_add_fail_ping: async () => "ok" },
    start: async () => { throw new Error("simulated start failure"); },
    stop: async () => {},
  };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: pluginId,
        name: pluginId,
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "lc_add_fail_ping", description: "lc_add_fail_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "x",
        publisher: "x",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const enableCalls: string[] = [];
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onEnable: (pluginId) => { enableCalls.push(pluginId); },
    });

    // addPlugin re-throws via `throwIfPluginFailedAfterAdd`; either way the
    // plugin should be in the failed set and onEnable must not have fired.
    await runtime.addPlugin(pluginId).catch(() => undefined);

    expect(enableCalls).toEqual([]);
    expect(runtime.listPluginIds()).not.toContain(pluginId);
  });
});

describe("buildImportUrl — cache-bust contract", () => {
  // 회귀 가드: restartPlugin/reloadPlugin 의 cache-bust 가 작동하려면
  // bustCache 인자에 따라 URL 이 달라져야 한다. 누군가 default 를 뒤집거나
  // bustCache 분기를 제거하면 plugin restart 가 silent 하게 stale 모듈 재사용
  // 회귀로 돌아간다 (이번 PR 의 root cause).
  const path = "/plugins/test-plugin/dist/hostPlugin.js";

  it("default (bustCache=false) returns stable URL across calls", () => {
    const a = buildImportUrl(path);
    const b = buildImportUrl(path);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\?reload=/);
  });

  it("bustCache=true returns a fresh ?reload= URL each call", async () => {
    const a = buildImportUrl(path, true);
    // 같은 ms 안에서도 후속 호출이 다르도록 — Date.now() 충돌 방지를
    // 위해 약간 대기. 충돌 시 본 contract 가 깨지면 monotonic counter
    // 도입 follow-up 이 필요한 신호.
    await new Promise((r) => setTimeout(r, 5));
    const b = buildImportUrl(path, true);
    expect(a).toMatch(/\?reload=\d+$/);
    expect(b).toMatch(/\?reload=\d+$/);
    expect(a).not.toBe(b);
  });
});
