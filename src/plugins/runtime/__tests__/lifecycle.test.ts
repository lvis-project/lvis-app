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
import { buildImportUrl } from "../sandbox.js";

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
        tools: ["lc_bust_version"],
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

  // The host wires `onDisable` to `toolRegistry.unregisterByPlugin(pluginId)`
  // (see boot/steps/plugin-runtime.ts). restartPlugin fires onDisable during
  // its stop phase but its start phase only re-populates `methodMap` — the
  // ToolRegistry is NOT touched. Callers MUST call `syncPluginToolRegistry`
  // after `restartPlugin` resolves; otherwise every plugin tool reports
  // `도구를 찾을 수 없습니다` until the next install/uninstall event fires.
  it("restartPlugin fires onDisable so callers know to re-sync ToolRegistry", async () => {
    const pluginDir = join(installedDir, "lc-restart-on-disable");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { lc_rod_ping: async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "lc-restart-on-disable",
        name: "LC",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["lc_rod_ping"],
        description: "x",
        publisher: "x",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "lc-restart-on-disable", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const onDisableCalls: string[] = [];
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (pluginId) => { onDisableCalls.push(pluginId); },
    });
    await runtime.startAll();
    onDisableCalls.length = 0;

    await runtime.restartPlugin("lc-restart-on-disable");

    expect(onDisableCalls).toEqual(["lc-restart-on-disable"]);
    // methodMap is back so the runtime call itself works — proving the bug
    // surface: methodMap recovered, but the toolRegistry-side cleanup ran
    // without a matching re-registration.
    await expect(runtime.call("lc_rod_ping")).resolves.toBe("ok");
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
