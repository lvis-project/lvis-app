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
import { afterEach, describe, it, expect, vi } from "vitest";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  markPluginWorkerWrapped,
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
} from "../../permissions/sandbox-capability.js";

// #885 v6 — the loopback consumes the NORMALIZED pure `Tool[]` (manifest == wire).
const MANIFEST: PluginManifest = {
  id: "com.example.notes",
  name: "Notes",
  version: "1.4.2",
  entry: "dist/index.js",
  description: "note ops",
  tools: [
    {
      name: "notes_read",
      description: "Read a note",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
    },
    {
      name: "notes_save",
      description: "Save a note",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
      _meta: { ui: { visibility: ["model"] }, "xyz.lvis/pathFields": ["path"] },
    },
  ],
};

describe("PluginMcpHost — first-party loopback registration + round-trip", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetWrappedPluginWorkersForTest();
  });

  it("registers plugin tools under natural names with plugin authority from _meta", async () => {
    const delegate: PluginToolDelegate = vi.fn(async (name, args) => ({
      content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      _meta: {
        ui: {
          resourceUri: "ui://notes/read.html",
          csp: { connectSrc: ["https://api.example.com"] },
        },
      },
    }));
    const registry = new ToolRegistry();
    const host = PluginMcpHost.loopback(MANIFEST, delegate, registry);

    const registered = await host.start();

    // Natural names — NO mcp_ namespace (first-party plugin, not external server).
    expect(registered).toEqual(["notes_read", "notes_save"]);

    const read = registry.findByName("notes_read");
    expect(read?.source).toBe("plugin");
    expect(read?.pluginId).toBe("com.example.notes");
    // #885 v6 — category is REMOVED from the wire; the reverse projection
    // registers the host-derived write-equivalent baseline (effective category
    // is computed host-side per invocation).
    expect(read?.category).toBe("write");
    expect(read?.pathFields).toEqual(["path"]);
    // wire carries no per-tool version → createDynamicTool "1.0.0" default.
    expect(read?.version).toBe("1.0.0");

    const save = registry.findByName("notes_save");
    expect(save?.category).toBe("write");
    // v6 — no self-attested worker identity or writesToOwnSandbox on the wire;
    // both stay undefined so the reviewer cannot relax on a plugin self-claim.
    expect(save?.workerId).toBeUndefined();
    expect(save?.writesToOwnSandbox).toBeUndefined();

    // tools/call round-trips host → loopback → server → delegate → back.
    const result = await read!.execute({ path: "/a.md" }, {} as never);
    expect(delegate).toHaveBeenCalledWith("notes_read", { path: "/a.md" });
    expect(result).toMatchObject({
      output: 'notes_read:{"path":"/a.md"}',
      isError: false,
      metadata: {
        uiPayload: { resourceUri: "ui://notes/read.html" },
      },
    });
    // A `csp` on the TOOL result is IGNORED — per spec it lives on the RESOURCE, and
    // main derives the sandbox-proxy CSP header from there.
    expect(
      (result.metadata as { uiPayload?: Record<string, unknown> }).uiPayload,
    ).not.toHaveProperty("csp");
  });

  it("keeps manifest workerId inert on the loopback path even when a worker marker exists", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("com.example.notes", "notes-worker");

    const registry = new ToolRegistry();
    const host = PluginMcpHost.loopback(
      MANIFEST,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
    );
    await host.start();

    const save = registry.findByName("notes_save");
    expect(save?.workerId).toBeUndefined();
    expect(
      resolveReviewerSandboxCapability(
        save!.source,
        save!.name,
        save!.mcpServerId,
        save!.workerId,
        save!.pluginId,
      ).kind,
    ).toBe("none");
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

  it("drops a tool whose inputSchema fails the #1182 provider-strict lint (parity)", async () => {
    const badManifest: PluginManifest = {
      id: "com.example.bad",
      name: "Bad",
      version: "1.0.0",
      entry: "dist/index.js",
      description: "bad",
      tools: [
        {
          name: "good_tool",
          description: "fine",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          _meta: { ui: { visibility: ["model"] } },
        },
        {
          name: "bad_tool",
          description: "array without items — OpenAI/Azure 400",
          inputSchema: { type: "object", properties: { tags: { type: "array" } } },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    };
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const registry = new ToolRegistry();
    const host = PluginMcpHost.loopback(badManifest, delegate, registry);

    const registered = await host.start();
    expect(registered).toEqual(["good_tool"]); // bad_tool dropped fail-soft
    expect(registry.findByName("bad_tool")).toBeUndefined();
  });

  it("rejects double start", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const host = PluginMcpHost.loopback(MANIFEST, delegate, new ToolRegistry());
    await host.start();
    await expect(host.start()).rejects.toThrow(/already started/);
  });
});
