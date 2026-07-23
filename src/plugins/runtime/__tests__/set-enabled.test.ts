/**
 * #1176 — PluginRuntime.setPluginEnabled / isPluginEnabled.
 *
 * Verifies the active/inactive toggle is orthogonal to load state:
 *   - setPluginEnabled(false) marks the plugin inactive, persists enabled=false
 *     to the registry, fires onActiveStateChange(false), and reports
 *     loadStatus="disabled" — but keeps the plugin LOADED.
 *   - setPluginEnabled(true) re-activates, persists enabled=true, fires
 *     onActiveStateChange(true).
 *   - an unknown plugin id throws.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestPluginRuntime } from "../../__tests__/test-helpers.js";
import { withPluginInstallLock } from "../../install-lifecycle.js";

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
        tools: [{ name: "se_ping", description: "se_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
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

  function makeRuntime(opts: {
    onDisable?: (id: string) => void;
    onEnable?: (id: string) => void;
    onActiveStateChange?: (id: string, enabled: boolean) => void;
  } = {}) {
    return makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir }, opts);
  }

  it("defaults to active (enabled !== false) for a freshly loaded plugin", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
  });

  it("disable marks inactive + persists enabled=false + fires active-state callback, plugin stays loaded", async () => {
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeRuntime({ onActiveStateChange: (id, enabled) => changes.push({ id, enabled }) });
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("se-plugin");

    await runtime.setPluginEnabled("se-plugin", false);

    // Active predicate flips, but the plugin is still loaded (no unload).
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(runtime.listPluginIds()).toContain("se-plugin");
    expect(changes).toEqual([{ id: "se-plugin", enabled: false }]);

    // Registry persisted enabled=false atomically.
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);

    // Card reports "disabled" even though the plugin is loaded.
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("disabled");
    expect(card?.runtimeLoaded).toBe(true);
    expect(card?.active).toBe(false);
  });

  it("re-enable marks active + persists enabled=true + fires active-state callback", async () => {
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeRuntime({ onActiveStateChange: (id, enabled) => changes.push({ id, enabled }) });
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    changes.length = 0;

    await runtime.setPluginEnabled("se-plugin", true);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    expect(changes).toEqual([{ id: "se-plugin", enabled: true }]);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(true);
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("loaded");
    expect(card?.runtimeLoaded).toBe(true);
    expect(card?.active).toBe(true);
  });

  it("serializes registry and active-state changes with canonical lifecycle mutations", async () => {
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeRuntime({
      onActiveStateChange: (id, enabled) => changes.push({ id, enabled }),
    });
    await runtime.startAll();

    let releaseMutation!: () => void;
    let markMutationEntered!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationEntered = new Promise<void>((resolve) => {
      markMutationEntered = resolve;
    });
    const mutation = withPluginInstallLock("se-plugin", async () => {
      markMutationEntered();
      await mutationGate;
    });
    await mutationEntered;

    const toggle = runtime.setPluginEnabled("se-plugin", false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    expect(changes).toEqual([]);
    expect(
      JSON.parse(await readFile(registryPath, "utf-8")).plugins[0].enabled,
    ).toBe(true);

    releaseMutation();
    await mutation;
    await toggle;
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(changes).toEqual([{ id: "se-plugin", enabled: false }]);
  });

  it("persists a canonical card toggle through its registry install alias", async () => {
    const installAlias = "se-install-alias";
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: installAlias, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeRuntime({
      onActiveStateChange: (id, enabled) => changes.push({ id, enabled }),
    });
    await runtime.startAll();

    await runtime.setPluginEnabled("se-plugin", false);
    expect(runtime.isPluginEnabled(installAlias)).toBe(false);
    let registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0]).toMatchObject({
      id: installAlias,
      enabled: false,
    });

    await runtime.setPluginEnabled(installAlias, true);
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins[0]).toMatchObject({
      id: installAlias,
      enabled: true,
    });
    expect(changes).toEqual([
      { id: "se-plugin", enabled: false },
      { id: "se-plugin", enabled: true },
    ]);
  });

  it("toggles a configured static plugin without inventing a registry row", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeTestPluginRuntime(
      { rootDir: testDir, registryPath, pluginsRoot: installedDir },
      {
        manifestPaths: [manifestPath],
        onActiveStateChange: (id, enabled) => changes.push({ id, enabled }),
      },
    );
    await runtime.startAll();

    await runtime.setPluginEnabled("se-plugin", false);
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    await runtime.setPluginEnabled("se-plugin", true);
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins).toEqual([]);
    expect(changes).toEqual([
      { id: "se-plugin", enabled: false },
      { id: "se-plugin", enabled: true },
    ]);
  });

  it("does not stop/reload the plugin instance on disable (call still resolves)", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    // The instance is untouched — the underlying method still resolves.
    await expect(runtime.call("se_ping")).resolves.toBe("pong");
  });

  it("clears stale inactive state when an enabled update removes and re-adds a plugin", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    await runtime.removePlugin("se-plugin");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "se-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("se-plugin")).resolves.toBe("started");
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    expect(runtime.listPluginCards().find((card) => card.id === "se-plugin"))
      .toMatchObject({
        active: true,
        loadStatus: "loaded",
        runtimeLoaded: true,
      });
  });

  it("throws for an unknown plugin id", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.setPluginEnabled("nope", false)).rejects.toThrow("Plugin not found: nope");
  });

  it("fails closed when the loaded plugin is missing from registry.json", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    await expect(runtime.setPluginEnabled("se-plugin", false)).rejects.toThrow(
      "Plugin not found in registry: se-plugin",
    );

    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("loaded");
    expect(card?.runtimeLoaded).toBe(true);
    expect(card?.active).toBe(true);
  });

  /**
   * M1 cross-restart regression — #1176.
   *
   * Scenario: user disables a plugin, app restarts. Before the fix, the boot
   * LOAD gate (registry filter + snapshots.ts) would skip loading the plugin
   * entirely, leaving inactivePluginIds empty. As a result:
   *   - isPluginEnabled("se-plugin") returned true (false negative)
   *   - setPluginEnabled("se-plugin", true) threw "Plugin not found"
   *
   * After the fix, ALL installed plugins are loaded regardless of enabled=false;
   * inactivePluginIds is seeded at boot from the persisted enabled=false value.
   */
  describe("cross-restart: boot from persisted enabled=false", () => {
    let disabledCalls: string[];
    let enabledCalls: string[];
    let runtime: ReturnType<typeof makeRuntime>;

    beforeEach(async () => {
      // Persist enabled=false in the registry BEFORE boot (simulates a restart
      // after the user previously disabled the plugin).
      await writeFile(
        registryPath,
        JSON.stringify({ version: 1, plugins: [{ id: "se-plugin", manifestPath, enabled: false }] }),
        "utf-8",
      );
      disabledCalls = [];
      enabledCalls = [];
      runtime = makeRuntime({
        onDisable: (id) => disabledCalls.push(id),
        onEnable: (id) => enabledCalls.push(id),
      });
      await runtime.startAll();
    });

    it("(a) plugin IS loaded despite enabled=false", () => {
      // The plugin should appear in listPluginIds (loaded into memory).
      expect(runtime.listPluginIds()).toContain("se-plugin");
    });

    it("(b) isPluginEnabled returns false immediately after boot", () => {
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
      expect(card?.loadStatus).toBe("disabled");
      expect(card?.runtimeLoaded).toBe(true);
      expect(card?.active).toBe(false);
    });

    it("(c) inactivePluginIds seeded at boot without lifecycle teardown callbacks", () => {
      // Model exposure is gated by ConversationLoop scope, not by removing
      // runtime tools from ToolRegistry. Boot only needs the active predicate.
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(disabledCalls).not.toContain("se-plugin");
    });

    it("(d) setPluginEnabled(true) succeeds after restart", async () => {
      // Before the M1 fix this threw "Plugin not found: se-plugin".
      await expect(runtime.setPluginEnabled("se-plugin", true)).resolves.toBeUndefined();
      expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
      expect(enabledCalls).not.toContain("se-plugin");
      const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
      expect(card?.loadStatus).toBe("loaded");
      expect(card?.runtimeLoaded).toBe(true);
      expect(card?.active).toBe(true);
    });
  });
});
