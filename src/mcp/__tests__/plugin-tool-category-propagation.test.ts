/**
 * #885 v6 — per-tool `category` is REMOVED from the plugin contract (Q3). The
 * loopback forward projection no longer emits `_meta["lvisai/category"]`, so
 * the reverse projection registers EVERY plugin tool at the write-equivalent
 * default-strict baseline. The effective category is derived HOST-side per
 * invocation (`resolveEnforcedCategory` / `inspectHostRisk`), NOT from the wire.
 *
 * This pins the security-preserving property that the 2026-06-26 permission
 * incident cared about: a plugin tool can NEVER register as `read` on the wire
 * (a silent downgrade would be a defect). The safe `write` baseline is now
 * UNIFORM across every plugin tool, and the whole plugin still loads (a missing
 * declaration was never — and is no longer — a hard fail).
 */
import { describe, it, expect, vi } from "vitest";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";

const MANIFEST: PluginManifest = {
  id: "com.example.mixed",
  name: "Mixed",
  version: "3.1.0",
  entry: "dist/index.js",
  description: "mixed-shape ops",
  tools: [
    {
      name: "mixed_read",
      description: "read-shaped op",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: "mixed_write",
      description: "write-shaped op",
      inputSchema: { type: "object", properties: { body: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: "mixed_undeclared",
      description: "no wire category",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      _meta: { ui: { visibility: ["model"] } },
    },
  ],
};

const okDelegate: PluginToolDelegate = vi.fn(async (name) => ({
  content: [{ type: "text", text: `ran ${name}` }],
}));

describe("#885 v6 — loopback plugin tools register write-equivalent (category is host-derived)", () => {
  it("registers the whole plugin, and EVERY tool at the write-equivalent baseline (never silently read)", async () => {
    const registry = new ToolRegistry();
    const registered = await PluginMcpHost.loopback(MANIFEST, okDelegate, registry).start();
    // Category is optional (host-classifies-risk) — the whole plugin still loads.
    expect(registered).toEqual(["mixed_read", "mixed_write", "mixed_undeclared"]);

    for (const name of registered) {
      const tool = registry.findByName(name);
      expect(tool?.source).toBe("plugin");
      // v6: the wire carries no category → uniform write-equivalent baseline.
      expect(tool?.category).toBe("write");
      // Security invariant: a plugin tool is NEVER silently classified read.
      expect(tool?.category).not.toBe("read");
      expect(tool?.isReadOnly({})).toBe(false);
    }
  });
});
