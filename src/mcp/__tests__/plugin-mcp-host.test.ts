/**
 * `PluginMcpHost` integration (mcp-alignment-design.md §3.1, first-party arm).
 *
 * Proves the production first-party path end-to-end: a LVIS manifest →
 * PluginMcpServer → loopback transport → PluginMcpHost discovers + registers the
 * plugin's tools into a real ToolRegistry under their NATURAL names with PLUGIN
 * authority (category from _meta), and tools/call round-trips to the delegate.
 * This is the reusable host the untrusted-stdio milestone re-points to a stdio
 * transport without changing registration.
 */
import { describe, it, expect, vi } from "vitest";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";

const MANIFEST: PluginManifest = {
  id: "com.example.notes",
  name: "Notes",
  version: "1.4.2",
  entry: "dist/index.js",
  description: "note ops",
  tools: ["notes_read", "notes_save"],
  toolSchemas: {
    notes_read: {
      description: "Read a note",
      category: "read",
      pathFields: ["path"],
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    notes_save: {
      description: "Save a note",
      category: "write",
      pathFields: ["path"],
      writesToOwnSandbox: true,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
    },
  },
} as PluginManifest;

describe("PluginMcpHost — first-party loopback registration + round-trip", () => {
  it("registers plugin tools under natural names with plugin authority from _meta", async () => {
    const delegate: PluginToolDelegate = vi.fn(async (name, args) => ({
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
    }));
    const registry = new ToolRegistry();
    const host = PluginMcpHost.loopback(MANIFEST, delegate, registry);

    const registered = await host.start();

    // Natural names — NO mcp_ namespace (first-party plugin, not external server).
    expect(registered).toEqual(["notes_read", "notes_save"]);

    const read = registry.findByName("notes_read");
    expect(read?.source).toBe("plugin");
    expect(read?.pluginId).toBe("com.example.notes");
    expect(read?.category).toBe("read"); // authority sourced from xyz.lvis/category
    expect(read?.pathFields).toEqual(["path"]);
    expect(read?.version).toBe("1.4.2"); // manifest version fallback via _meta

    const save = registry.findByName("notes_save");
    expect(save?.category).toBe("write");
    expect(save?.writesToOwnSandbox).toBe(true);

    // tools/call round-trips host → loopback → server → delegate → back.
    const result = await read!.execute({ path: "/a.md" }, {} as never);
    expect(delegate).toHaveBeenCalledWith("notes_read", { path: "/a.md" });
    expect(result).toEqual({ output: 'notes_read:{"path":"/a.md"}', isError: false });
  });

  it("surfaces a thrown delegate as an isError tool result (not a host throw)", async () => {
    const delegate: PluginToolDelegate = async () => {
      throw new Error("note locked");
    };
    const registry = new ToolRegistry();
    const host = PluginMcpHost.loopback(MANIFEST, delegate, registry);
    await host.start();

    const result = await registry.findByName("notes_read")!.execute({ path: "/x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("note locked");
  });

  it("stop() unregisters the plugin's tools", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const registry = new ToolRegistry();
    const host = PluginMcpHost.loopback(MANIFEST, delegate, registry);
    await host.start();
    expect(registry.findByName("notes_read")).toBeDefined();

    await host.stop();
    expect(registry.findByName("notes_read")).toBeUndefined();
    expect(registry.findByName("notes_save")).toBeUndefined();
  });

  it("rejects double start", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const host = PluginMcpHost.loopback(MANIFEST, delegate, new ToolRegistry());
    await host.start();
    await expect(host.start()).rejects.toThrow(/already started/);
  });
});
