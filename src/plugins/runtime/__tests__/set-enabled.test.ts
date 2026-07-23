/**
 * #1176 — PluginRuntime.setPluginEnabled / isPluginEnabled.
 *
 * Verifies enabled state is identical to immutable-generation admission:
 *   - disable publishes the inactive pointer and drains teardown;
 *   - re-enable reverifies receipt-covered bytes and publishes a new generation.
 *   - an unknown plugin id throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestPluginRuntime } from "../../__tests__/test-helpers.js";
import { buildInstallReceipt, writeInstallReceipt } from "../../plugin-install-receipt.js";

const registryCommitGate = vi.hoisted(() => ({
  started: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock("../../registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../registry.js")>();
  return {
    ...actual,
    updatePluginRegistry: async (
      ...args: Parameters<typeof actual.updatePluginRegistry>
    ) => {
      registryCommitGate.started?.();
      if (registryCommitGate.wait) await registryCommitGate.wait;
      return actual.updatePluginRegistry(...args);
    },
  };
});

describe("PluginRuntime — active/inactive toggle (#1176)", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let manifestPath: string;

  async function makeTreeWritable(path: string): Promise<void> {
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeTreeWritable(join(path, entry.name));
    }
  }

  function holdRegistryCommit(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      registryCommitGate.release = resolve;
    });
    registryCommitGate.started = markStarted;
    registryCommitGate.wait = wait;
    return {
      started,
      release: () => {
        const release = registryCommitGate.release;
        registryCommitGate.started = undefined;
        registryCommitGate.wait = undefined;
        registryCommitGate.release = undefined;
        release?.();
      },
    };
  }

  function releaseRegistryCommit(): void {
    const release = registryCommitGate.release;
    registryCommitGate.started = undefined;
    registryCommitGate.wait = undefined;
    registryCommitGate.release = undefined;
    release?.();
  }

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
    const { receipt } = await buildInstallReceipt(pluginDir, {
      pluginId: "se-plugin",
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "poc-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    await writeInstallReceipt(testDir, receipt);
  });

  afterEach(async () => {
    releaseRegistryCommit();
    await makeTreeWritable(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  function makeRuntime(opts: {
    onDisable?: (id: string) => void;
    onEnable?: (id: string) => void;
    onActiveStateChange?: (id: string, enabled: boolean) => Promise<void> | void;
  } = {}) {
    return makeTestPluginRuntime(
      { rootDir: testDir, registryPath, pluginsRoot: installedDir },
      { ...opts, installReceiptCacheRoot: testDir },
    );
  }

  it("defaults to active (enabled !== false) for a freshly loaded plugin", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
  });

  it("disable publishes an inactive pointer, drains runtime, persists false, and fires the callback", async () => {
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeRuntime({ onActiveStateChange: (id, enabled) => changes.push({ id, enabled }) });
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("se-plugin");

    await runtime.setPluginEnabled("se-plugin", false);

    // No runtime instance or generation admission remains after terminal success.
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(runtime.listPluginIds()).not.toContain("se-plugin");
    expect(changes).toEqual([{ id: "se-plugin", enabled: false }]);

    // Registry persisted enabled=false atomically.
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);

    // Metadata remains discoverable for an explicit verified re-enable.
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("disabled");
    expect(card?.runtimeLoaded).toBe(false);
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

  it("uninstalls an inactive plugin and permits a clean same-id reinstall", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);

    const removed = await runtime.removePluginWithCommit(
      "se-plugin",
      async () => {
        await writeFile(
          registryPath,
          JSON.stringify({ version: 1, plugins: [] }),
          "utf-8",
        );
        return "removed";
      },
    );

    expect(removed).toBe("removed");
    expect(runtime.listPluginCards().find((card) => card.id === "se-plugin")).toBeUndefined();

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
    await expect(runtime.call("se_ping")).resolves.toBe("pong");
  });

  it("preserves a later enable while an earlier disable commit is delayed", async () => {
    const changes: boolean[] = [];
    const runtime = makeRuntime({
      onActiveStateChange: (_id, enabled) => changes.push(enabled),
    });
    await runtime.startAll();
    const commit = holdRegistryCommit();

    const disable = runtime.setPluginEnabled("se-plugin", false);
    await commit.started;
    const enable = runtime.setPluginEnabled("se-plugin", true);
    commit.release();
    await Promise.all([disable, enable]);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    expect(changes).toEqual([false, true]);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(true);
  });

  it("preserves a later disable while an earlier enable commit is delayed", async () => {
    const changes: boolean[] = [];
    const runtime = makeRuntime({
      onActiveStateChange: (_id, enabled) => changes.push(enabled),
    });
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    changes.length = 0;
    const commit = holdRegistryCommit();

    const enable = runtime.setPluginEnabled("se-plugin", true);
    await commit.started;
    const disable = runtime.setPluginEnabled("se-plugin", false);
    commit.release();
    await Promise.all([enable, disable]);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(changes).toEqual([true, false]);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);
  });

  it("admits no new runtime call after disable", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    await expect(runtime.call("se_ping")).rejects.toThrow("Plugin method not found: se_ping");
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

  it("keeps committed state aligned when a post-commit host callback fails", async () => {
    const onActiveStateChange = vi.fn(async () => { throw new Error("MCP projection failed"); });
    const runtime = makeRuntime({ onActiveStateChange });
    await runtime.startAll();

    await expect(runtime.setPluginEnabled("se-plugin", false)).rejects.toThrow("MCP projection failed");

    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);
  });

  it("projects the committed inactive state even when runtime retirement fails", async () => {
    const onActiveStateChange = vi.fn();
    const runtime = makeRuntime({ onActiveStateChange });
    await runtime.startAll();
    const prepareRuntimeRetirement =
      runtime.prepareRuntimeRetirement.bind(runtime);
    vi.spyOn(runtime, "prepareRuntimeRetirement").mockImplementation(
      (projection) =>
        prepareRuntimeRetirement(projection).map((step) =>
          step.phase === "runtime.drain"
            ? Object.freeze({
                ...step,
                run: async () => {
                  throw new Error("retirement drain failed");
                },
              })
            : step),
    );

    await expect(runtime.setPluginEnabled("se-plugin", false)).rejects.toThrow(
      /generation retirement failed/,
    );

    expect(onActiveStateChange).toHaveBeenCalledWith("se-plugin", false);
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);
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
   * After the fix, installed metadata remains discoverable while no runtime or
   * active generation is admitted until the receipt is reverified.
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

    it("(a) plugin metadata is known but runtime is not loaded", () => {
      expect(runtime.listPluginIds()).not.toContain("se-plugin");
      expect(runtime.listPluginCards().find((card) => card.id === "se-plugin")).toBeDefined();
    });

    it("(b) isPluginEnabled returns false immediately after boot", () => {
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
      expect(card?.loadStatus).toBe("disabled");
      expect(card?.runtimeLoaded).toBe(false);
      expect(card?.active).toBe(false);
    });

    it("(c) inactivePluginIds seeded at boot without lifecycle teardown callbacks", () => {
      // Boot publishes no runtime projection and fires no teardown callback.
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(disabledCalls).not.toContain("se-plugin");
    });

    it("(d) setPluginEnabled(true) succeeds after restart", async () => {
      // Before the M1 fix this threw "Plugin not found: se-plugin".
      await expect(runtime.setPluginEnabled("se-plugin", true)).resolves.toBeUndefined();
      expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
      expect(enabledCalls).toContain("se-plugin");
      const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
      expect(card?.loadStatus).toBe("loaded");
      expect(card?.runtimeLoaded).toBe(true);
      expect(card?.active).toBe(true);
    });

    it("(e) rejects tampered installed bytes and keeps the inactive registry state", async () => {
      await writeFile(join(installedDir, "se-plugin", "entry.mjs"), "export default () => ({ handlers: {} });\n");
      await expect(runtime.setPluginEnabled("se-plugin", true)).rejects.toThrow(/verification failed/);
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(runtime.listPluginIds()).not.toContain("se-plugin");
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      expect(registry.plugins[0].enabled).toBe(false);
    });
  });
});
