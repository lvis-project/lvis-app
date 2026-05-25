/**
 * syncPluginToolRegistry — install / update / uninstall / reinstall lifecycle.
 *
 * Regression for the bug where ToolRegistry kept stale tool entries after
 * runtime plugin lifecycle events. Asserts the idempotent full-resync
 * contract: registry plugin tools always mirror PluginRuntime state, no
 * ghost entries linger across uninstall, no duplicate-registration throw
 * on reinstall of the same name@version.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
}));

import {
  syncPluginToolRegistry,
  syncPluginToolRegistryForPlugin,
} from "../plugins.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";

interface Entry {
  pluginId: string;
  manifest: PluginManifest;
}

function stubRuntime(entries: Entry[], inactiveIds: Set<string> = new Set()): PluginRuntime {
  return {
    listPluginManifests: () => entries,
    // #1176 M3: syncPluginToolRegistry gates on isPluginEnabled to suppress
    // inactive-plugin tools from non-scoped registry reads.
    isPluginEnabled: (pluginId: string) => !inactiveIds.has(pluginId),
  } as unknown as PluginRuntime;
}

function manifest(id: string, tools: string[], version = "1.0.0"): PluginManifest {
  return {
    id,
    name: id,
    version,
    description: "",
    entry: "dist/main/main.js",
    tools,
    toolSchemas: Object.fromEntries(
      tools.map((tool) => [
        tool,
        {
          description: `Execute ${tool} test tool`,
          category: "write",
          inputSchema: { type: "object", properties: {} },
        },
      ]),
    ),
  } as unknown as PluginManifest;
}

describe("syncPluginToolRegistry — plugin lifecycle sync", () => {
  it("install: registers tools for a freshly added plugin", () => {
    const registry = new ToolRegistry();
    const runtime = stubRuntime([
      { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"]) },
    ]);

    syncPluginToolRegistry(runtime, registry);

    expect(registry.findByName("alpha_run")?.pluginId).toBe("alpha");
  });

  it("uninstall: clears ghost tools whose plugin is no longer in the runtime", () => {
    const registry = new ToolRegistry();
    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"]) },
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"]) },
      ]),
      registry,
    );
    expect(registry.findByName("beta_run")).toBeDefined();

    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"]) },
      ]),
      registry,
    );

    expect(registry.findByName("alpha_run")?.pluginId).toBe("alpha");
    expect(registry.findByName("beta_run")).toBeUndefined();
  });

  it("reinstall same version: no duplicate-registration throw", () => {
    const registry = new ToolRegistry();
    const runtime = stubRuntime([
      { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "1.0.0") },
    ]);

    syncPluginToolRegistry(runtime, registry);
    expect(() => syncPluginToolRegistry(runtime, registry)).not.toThrow();
    expect(registry.findByName("alpha_run")?.pluginId).toBe("alpha");
    expect(registry.listVersions("alpha_run")).toHaveLength(1);
  });

  it("update bumps version: only the new version remains visible", () => {
    const registry = new ToolRegistry();
    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "1.0.0") },
      ]),
      registry,
    );
    expect(registry.findByName("alpha_run")?.version).toBe("1.0.0");

    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "2.0.0") },
      ]),
      registry,
    );

    expect(registry.findByName("alpha_run")?.version).toBe("2.0.0");
    expect(registry.listVersions("alpha_run")).toHaveLength(1);
  });

  it("preserves non-plugin tools (builtins, MCP) across resync", () => {
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "builtin_thing",
      description: "host-owned",
      source: "builtin",
      version: "1.0.0",
      jsonSchema: { type: "object", properties: {} },
      category: "read",
      execute: async () => ({ output: "", isError: false }),
    }));

    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"]) },
      ]),
      registry,
    );
    expect(registry.findByName("builtin_thing")).toBeDefined();
    expect(registry.findByName("alpha_run")).toBeDefined();

    syncPluginToolRegistry(stubRuntime([]), registry);
    expect(registry.findByName("builtin_thing")).toBeDefined();
    expect(registry.findByName("alpha_run")).toBeUndefined();
  });

  it("never removes non-plugin tools even when they carry pluginId metadata", () => {
    const registry = new ToolRegistry();
    const hostTool = createDynamicTool({
      name: "builtin_shadow",
      description: "host-owned metadata edge case",
      source: "builtin",
      pluginId: "alpha",
      version: "1.0.0",
      jsonSchema: { type: "object", properties: {} },
      category: "read",
      execute: async () => ({ output: "", isError: false }),
    });
    registry.register(hostTool);

    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"]) },
      ]),
      registry,
    );
    expect(registry.findByName("builtin_shadow")).toBe(hostTool);
    expect(registry.findByName("alpha_run")?.pluginId).toBe("alpha");

    syncPluginToolRegistryForPlugin(stubRuntime([]), registry, "alpha");
    expect(registry.findByName("builtin_shadow")).toBe(hostTool);
    expect(registry.findByName("alpha_run")).toBeUndefined();
  });

  it("targeted sync updates only the requested plugin and preserves bystander tool identity", () => {
    const registry = new ToolRegistry();
    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "1.0.0") },
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"], "1.0.0") },
      ]),
      registry,
    );
    const betaBefore = registry.findByName("beta_run");
    expect(betaBefore?.pluginId).toBe("beta");

    syncPluginToolRegistryForPlugin(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "2.0.0") },
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"], "2.0.0") },
      ]),
      registry,
      "alpha",
    );

    expect(registry.findByName("alpha_run")?.version).toBe("2.0.0");
    expect(registry.findByName("beta_run")).toBe(betaBefore);
    expect(registry.findByName("beta_run")?.version).toBe("1.0.0");
  });

  it("targeted sync rolls back atomically when the target plugin manifest is invalid", () => {
    const registry = new ToolRegistry();
    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "1.0.0") },
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"], "1.0.0") },
      ]),
      registry,
    );
    const alphaBefore = registry.findByName("alpha_run");
    const betaBefore = registry.findByName("beta_run");

    expect(() => syncPluginToolRegistryForPlugin(
      stubRuntime([
        {
          pluginId: "alpha",
          manifest: {
            ...manifest("alpha", ["alpha_run"], "2.0.0"),
            toolSchemas: {
              alpha_run: {
                description: "Invalid alpha tool without category",
                inputSchema: { type: "object", properties: {} },
              },
            },
          },
        },
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"], "2.0.0") },
      ]),
      registry,
      "alpha",
    )).toThrow(/category is required/);

    expect(registry.findByName("alpha_run")).toBe(alphaBefore);
    expect(registry.findByName("alpha_run")?.version).toBe("1.0.0");
    expect(registry.findByName("beta_run")).toBe(betaBefore);
    expect(registry.findByName("beta_run")?.version).toBe("1.0.0");
  });

  it("targeted sync removes a single ghost plugin without sweeping bystanders", () => {
    const registry = new ToolRegistry();
    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"]) },
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"]) },
      ]),
      registry,
    );
    const betaBefore = registry.findByName("beta_run");

    syncPluginToolRegistryForPlugin(
      stubRuntime([
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"], "2.0.0") },
      ]),
      registry,
      "alpha",
    );

    expect(registry.findByName("alpha_run")).toBeUndefined();
    expect(registry.findByName("beta_run")).toBe(betaBefore);
  });

  it("restartAll-style targeted fan-out updates each plugin only on its own onEnable turn", () => {
    const registry = new ToolRegistry();
    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "1.0.0") },
        { pluginId: "beta", manifest: manifest("beta", ["beta_run"], "1.0.0") },
      ]),
      registry,
    );
    const betaBefore = registry.findByName("beta_run");
    const nextRuntime = stubRuntime([
      { pluginId: "alpha", manifest: manifest("alpha", ["alpha_run"], "2.0.0") },
      { pluginId: "beta", manifest: manifest("beta", ["beta_run"], "2.0.0") },
    ]);

    syncPluginToolRegistryForPlugin(nextRuntime, registry, "alpha");
    const alphaAfter = registry.findByName("alpha_run");
    expect(alphaAfter?.version).toBe("2.0.0");
    expect(registry.findByName("beta_run")).toBe(betaBefore);

    syncPluginToolRegistryForPlugin(nextRuntime, registry, "beta");
    expect(registry.findByName("alpha_run")).toBe(alphaAfter);
    expect(registry.findByName("beta_run")?.version).toBe("2.0.0");
  });

  /**
   * M3 regression — #1176: inactive-plugin tools must not appear in the
   * non-scoped registry after syncPluginToolRegistry.
   *
   * Before the fix, syncPluginToolRegistry iterated listPluginManifests()
   * without filtering on isPluginEnabled, so inactive plugins' tools leaked
   * into getVisibleTools(), the boot log, and the system-prompt Source 5
   * scope===undefined fallback. The per-turn resolveToolScope was fine but
   * defense-in-depth was broken.
   */
  describe("M3 — inactive-plugin tool suppression in syncPluginToolRegistry", () => {
    it("inactive plugin tools absent from getVisibleTools() after boot sync", () => {
      const registry = new ToolRegistry();
      const inactiveIds = new Set(["inactive-plugin"]);
      const runtime = stubRuntime(
        [
          { pluginId: "active-plugin", manifest: manifest("active-plugin", ["active_run"]) },
          { pluginId: "inactive-plugin", manifest: manifest("inactive-plugin", ["inactive_run"]) },
        ],
        inactiveIds,
      );

      syncPluginToolRegistry(runtime, registry);

      // Active plugin tool is registered and visible.
      expect(registry.findByName("active_run")?.pluginId).toBe("active-plugin");
      // Inactive plugin tool must NOT be in the registry at all.
      expect(registry.findByName("inactive_run")).toBeUndefined();
      const visibleNames = registry.getVisibleTools().map((t) => t.name);
      expect(visibleNames).toContain("active_run");
      expect(visibleNames).not.toContain("inactive_run");
    });

    it("re-enable: syncPluginToolRegistryForPlugin registers tools after activation", () => {
      const registry = new ToolRegistry();
      const inactiveIds = new Set(["my-plugin"]);
      const entries = [
        { pluginId: "my-plugin", manifest: manifest("my-plugin", ["my_tool"]) },
      ];

      // Boot sync with plugin inactive — tools absent.
      syncPluginToolRegistry(stubRuntime(entries, inactiveIds), registry);
      expect(registry.findByName("my_tool")).toBeUndefined();

      // Simulate onEnable: plugin is now active, targeted sync re-registers.
      syncPluginToolRegistryForPlugin(stubRuntime(entries, new Set()), registry, "my-plugin");
      expect(registry.findByName("my_tool")?.pluginId).toBe("my-plugin");
      const visibleNames = registry.getVisibleTools().map((t) => t.name);
      expect(visibleNames).toContain("my_tool");
    });

    it("active plugin tools always present even when other plugins are inactive", () => {
      const registry = new ToolRegistry();
      const inactiveIds = new Set(["b"]);
      syncPluginToolRegistry(
        stubRuntime(
          [
            { pluginId: "a", manifest: manifest("a", ["a_run"]) },
            { pluginId: "b", manifest: manifest("b", ["b_run"]) },
            { pluginId: "c", manifest: manifest("c", ["c_run"]) },
          ],
          inactiveIds,
        ),
        registry,
      );

      expect(registry.findByName("a_run")?.pluginId).toBe("a");
      expect(registry.findByName("b_run")).toBeUndefined();
      expect(registry.findByName("c_run")?.pluginId).toBe("c");
    });
  });

  it("requires SDK-backed plugin authority metadata before registering tools", () => {
    const registry = new ToolRegistry();
    syncPluginToolRegistry(
      stubRuntime([
        { pluginId: "stable", manifest: manifest("stable", ["stable_run"]) },
      ]),
      registry,
    );
    const stableBefore = registry.findByName("stable_run");
    const runtime = stubRuntime([
      {
        pluginId: "alpha",
        manifest: {
          ...manifest("alpha", ["alpha_read", "alpha_write"]),
          toolSchemas: {
            alpha_read: {
              description: "Read-only alpha lookup tool",
              inputSchema: { type: "object", properties: {} },
            },
            alpha_write: {
              description: "Alpha mutating tool without category",
              inputSchema: { type: "object", properties: {} },
            },
          },
        },
      },
    ]);

    expect(() => syncPluginToolRegistry(runtime, registry)).toThrow(/category is required/);
    expect(registry.findByName("stable_run")).toBe(stableBefore);
    expect(registry.findByName("alpha_read")).toBeUndefined();
    expect(registry.findByName("alpha_write")).toBeUndefined();

    const validRuntime = stubRuntime([
      { pluginId: "stable", manifest: manifest("stable", ["stable_run"]) },
      {
        pluginId: "alpha",
        manifest: {
          ...manifest("alpha", ["alpha_read", "alpha_write"]),
          toolSchemas: {
            alpha_read: {
              description: "Read-only alpha lookup tool",
              category: "read",
              inputSchema: { type: "object", properties: {} },
            },
            alpha_write: {
              description: "Alpha mutating tool",
              category: "write",
              pathFields: ["path"],
              inputSchema: { type: "object", properties: {} },
            },
          },
        },
      },
    ]);

    syncPluginToolRegistry(validRuntime, registry);

    const read = registry.findByName("alpha_read");
    const write = registry.findByName("alpha_write");
    expect(read?.category).toBe("read");
    expect(read?.isReadOnly({})).toBe(true);
    expect(write?.category).toBe("write");
    expect(write?.pathFields).toEqual(["path"]);
    expect(write?.isReadOnly({})).toBe(false);
  });
});
