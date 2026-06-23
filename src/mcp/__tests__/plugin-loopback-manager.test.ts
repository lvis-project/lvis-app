/**
 * `PluginLoopbackManager` lifecycle (mcp-alignment-design.md §3.1).
 * The boot cutover seam: start on enable, stop on disable, idempotent reload,
 * stopAll on shutdown — driving real PluginMcpHosts over a real ToolRegistry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginLoopbackManager } from "../plugin-loopback-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { manifestIntegrityState } from "../../permissions/manifest-integrity.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";

beforeEach(() => manifestIntegrityState.resetForTests());

function manifest(id: string, tools: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    entry: "dist/index.js",
    description: id,
    tools,
    toolSchemas: Object.fromEntries(
      tools.map((t) => [
        t,
        { description: t, category: "read", inputSchema: { type: "object", properties: {} } },
      ]),
    ),
  } as PluginManifest;
}

function fakeRuntime(): PluginRuntime {
  return {
    isPluginEnabled: () => true,
    call: vi.fn(async (name: string) => `ran ${name}`),
  } as unknown as PluginRuntime;
}

/**
 * A category-less manifest. Under host-classifies-risk this loads as
 * write-equivalent (default-strict) rather than throwing — used to pin that
 * the missing-category hard-fail is gone.
 */
function categorylessManifest(id: string, tool: string): PluginManifest {
  return {
    id,
    name: id,
    version: "2.0.0",
    entry: "dist/index.js",
    description: id,
    tools: [tool],
    toolSchemas: { [tool]: { description: tool, inputSchema: { type: "object", properties: {} } } },
  } as unknown as PluginManifest;
}

describe("PluginLoopbackManager", () => {
  it("start registers a plugin's tools and tracks the host", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    const names = await mgr.start(manifest("com.a", ["a_one", "a_two"]));
    expect(names).toEqual(["a_one", "a_two"]);
    expect(mgr.has("com.a")).toBe(true);
    expect(mgr.list()).toEqual(["com.a"]);
    expect(registry.findByName("a_one")?.pluginId).toBe("com.a");
  });

  it("start is idempotent — a reload re-registers without duplicating", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_one"]));
    // Reload with a changed tool set — old tool gone, new tool present, one host.
    const names = await mgr.start(manifest("com.a", ["a_renamed"]));
    expect(names).toEqual(["a_renamed"]);
    expect(mgr.list()).toEqual(["com.a"]);
    expect(registry.findByName("a_one")).toBeUndefined();
    expect(registry.findByName("a_renamed")?.pluginId).toBe("com.a");
  });

  it("stop unregisters one plugin's tools and forgets the host", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);
    await mgr.start(manifest("com.a", ["a_one"]));
    await mgr.start(manifest("com.b", ["b_one"]));

    await mgr.stop("com.a");
    expect(mgr.has("com.a")).toBe(false);
    expect(registry.findByName("a_one")).toBeUndefined();
    // Bystander untouched.
    expect(registry.findByName("b_one")?.pluginId).toBe("com.b");
    expect(mgr.list()).toEqual(["com.b"]);
  });

  it("stop is a no-op for an unknown plugin", async () => {
    const mgr = new PluginLoopbackManager(fakeRuntime(), new ToolRegistry());
    await expect(mgr.stop("nope")).resolves.toBeUndefined();
  });

  it("category-less reload now loads write-equivalent (default-strict), not a hard fail", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_one"]));
    // host-classifies-risk: a category-less tool no longer aborts the load — it
    // registers at the write-equivalent default-strict baseline.
    await expect(mgr.start(categorylessManifest("com.a", "a_bad"))).resolves.toEqual(["a_bad"]);
    expect(registry.findByName("a_bad")?.category).toBe("write");
    // The reload atomically swapped com.a's tool set.
    expect(registry.findByName("a_one")).toBeUndefined();
    expect(mgr.list()).toEqual(["com.a"]);
  });

  it("atomic reload: a failed reload keeps the PREVIOUS tools (no zero-tools window)", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_one"]));
    const before = registry.findByName("a_one");
    expect(before?.pluginId).toBe("com.a");
    // A bystander plugin owns the name the reload will try to claim.
    await mgr.start(manifest("com.b", ["clash"]));

    // Reload com.a declaring a tool name already owned by com.b → the atomic
    // swap's cross-plugin name-collision guard throws, leaving com.a's previous
    // registration fully intact (no zero-tools window).
    await expect(mgr.start(manifest("com.a", ["clash"]))).rejects.toThrow(
      /name collision/i,
    );

    expect(registry.findByName("a_one")).toBe(before);
    expect(registry.findByName("clash")?.pluginId).toBe("com.b");
    expect(mgr.list().sort()).toEqual(["com.a", "com.b"]);
  });

  it("atomic reload: a successful reload swaps to the new tool set", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_old"]));
    expect(registry.findByName("a_old")?.pluginId).toBe("com.a");

    await mgr.start(manifest("com.a", ["a_new"]));
    expect(registry.findByName("a_old")).toBeUndefined();
    expect(registry.findByName("a_new")?.pluginId).toBe("com.a");
    expect(mgr.list()).toEqual(["com.a"]);
  });

  it("syncAll reconciles: starts present plugins, stops gone ones, leaves bystanders untouched", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.syncAll([
      { pluginId: "com.a", manifest: manifest("com.a", ["a_one"]) },
      { pluginId: "com.b", manifest: manifest("com.b", ["b_one"]) },
    ]);
    expect(mgr.list().sort()).toEqual(["com.a", "com.b"]);
    const bystander = registry.findByName("a_one");

    // Re-sync with com.b removed (uninstall): b's tools gone, a's identity preserved.
    await mgr.syncAll([{ pluginId: "com.a", manifest: manifest("com.a", ["a_one"]) }]);
    expect(mgr.list()).toEqual(["com.a"]);
    expect(registry.findByName("b_one")).toBeUndefined();
    expect(registry.findByName("a_one")).toBe(bystander); // not churned (has()-guard)
  });

  it("stopAll tears down every running host", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);
    await mgr.start(manifest("com.a", ["a_one"]));
    await mgr.start(manifest("com.b", ["b_one"]));

    await mgr.stopAll();
    expect(mgr.list()).toEqual([]);
    expect(registry.findByName("a_one")).toBeUndefined();
    expect(registry.findByName("b_one")).toBeUndefined();
  });
});
