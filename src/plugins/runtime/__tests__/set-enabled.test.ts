/**
 * #1176 — PluginRuntime.setPluginEnabled / isPluginEnabled.
 *
 * Verifies the active/inactive toggle is orthogonal to load state:
 *   - setPluginEnabled(false) marks the plugin inactive, persists enabled=false
 *     to the registry, fires onDisable, and reports loadStatus="disabled" — but
 *     keeps the plugin LOADED (listPluginIds still contains it; no stop/reload).
 *   - setPluginEnabled(true) re-activates, persists enabled=true, fires onEnable.
 *   - an unknown plugin id throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestPluginRuntime } from "../../__tests__/test-helpers.js";

describe("PluginRuntime — active/inactive toggle (#1176)", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let manifestPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-set-enabled-"));
    installedDir = join(testDir, "plugins");
    const pluginDir = join(installedDir, "se-plugin");
    await mkdir(pluginDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
    manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { se_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "se-plugin",
        name: "SE Plugin",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["se_ping"],
        description: "set-enabled test",
        publisher: "Test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "se-plugin", manifestPath, enabled: true }] }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeRuntime(opts: { onDisable?: (id: string) => void; onEnable?: (id: string) => void } = {}) {
    return makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir }, opts);
  }

  it("defaults to active (enabled !== false) for a freshly loaded plugin", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
  });

  it("disable marks inactive + persists enabled=false + fires onDisable, plugin stays loaded", async () => {
    const disabled: string[] = [];
    const runtime = makeRuntime({ onDisable: (id) => disabled.push(id) });
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("se-plugin");

    await runtime.setPluginEnabled("se-plugin", false);

    // Active predicate flips, but the plugin is still loaded (no unload).
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(runtime.listPluginIds()).toContain("se-plugin");
    expect(disabled).toEqual(["se-plugin"]);

    // Registry persisted enabled=false atomically.
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);

    // Card reports "disabled" even though the plugin is loaded.
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("disabled");
  });

  it("re-enable marks active + persists enabled=true + fires onEnable", async () => {
    const enabled: string[] = [];
    const runtime = makeRuntime({ onEnable: (id) => enabled.push(id) });
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    enabled.length = 0; // ignore any onEnable from boot

    await runtime.setPluginEnabled("se-plugin", true);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    expect(enabled).toContain("se-plugin");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(true);
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("loaded");
  });

  it("does not stop/reload the plugin instance on disable (call still resolves)", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    // The instance is untouched — the underlying method still resolves.
    await expect(runtime.call("se_ping")).resolves.toBe("pong");
  });

  it("throws for an unknown plugin id", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.setPluginEnabled("nope", false)).rejects.toThrow("Plugin not found: nope");
  });
});
