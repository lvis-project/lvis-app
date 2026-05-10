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

import { syncPluginToolRegistry } from "../plugins.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";

interface Entry {
  pluginId: string;
  manifest: PluginManifest;
}

function stubRuntime(entries: Entry[]): PluginRuntime {
  return {
    listPluginManifests: () => entries,
  } as unknown as PluginRuntime;
}

function manifest(id: string, tools: string[], version = "1.0.0"): PluginManifest {
  return {
    id,
    name: id,
    version,
    description: "",
    entry: "dist/main.js",
    tools,
    toolSchemas: Object.fromEntries(
      tools.map((tool) => [
        tool,
        {
          description: `Execute ${tool} test tool`,
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

  it("registers plugin tool permission category and treats omitted category as conservative write", () => {
    const registry = new ToolRegistry();
    const runtime = stubRuntime([
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
              description: "Alpha mutating tool without category",
              inputSchema: { type: "object", properties: {} },
            },
          },
        },
      },
    ]);

    syncPluginToolRegistry(runtime, registry);
    expect(registry.findByName("alpha_read")?.category).toBe("read");
    expect(registry.findByName("alpha_write")?.category).toBe("write");

    const validRuntime = stubRuntime([
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
    expect(write?.isReadOnly({})).toBe(false);
  });
});
