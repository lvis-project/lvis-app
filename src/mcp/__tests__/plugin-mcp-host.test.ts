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
import { createPluginUiResourceProvider } from "../plugin-ui-resource-provider.js";
import type { PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  markPluginWorkerWrapped,
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
} from "../../permissions/sandbox-capability.js";
import { testLoopbackHost } from "./plugin-mcp-test-helpers.js";

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
      _meta: { ui: { visibility: ["model"] }, "lvisai/pathFields": ["path"] },
    },
    {
      name: "notes_save",
      description: "Save a note",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      },
      _meta: { ui: { visibility: ["model"] }, "lvisai/pathFields": ["path"] },
    },
  ],
};

async function publishTestHost(
  host: PluginMcpHost,
  pluginId: string,
  registry: ToolRegistry,
): Promise<string[]> {
  const tools = await host.prepareTools();
  registry.reservePluginReplacement(pluginId, tools, []).publish();
  host.publishPrepared(tools);
  return tools.map((tool) => tool.name);
}

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
    const host = testLoopbackHost(MANIFEST, delegate, registry);

    const registered = await publishTestHost(host, MANIFEST.id, registry);

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

  it("fails preparation when the wire operation policy differs from the signed Tool", async () => {
    const manifest = structuredClone(MANIFEST);
    manifest.tools[0]._meta = {
      ...manifest.tools[0]._meta,
      "lvisai/operationPolicy": {
        discriminant: "operation",
        operations: { read: { kind: "read", minimumRisk: "read", appVisible: true } },
      },
    };
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      manifest,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
    );
    manifest.tools[0]._meta!["lvisai/operationPolicy"] = {
      discriminant: "operation",
      operations: { write: { kind: "write", minimumRisk: "write", appVisible: true } },
    };

    await expect(host.prepareTools()).rejects.toThrow(/differs from its signed manifest/);
    expect(registry.findByName("notes_read")).toBeUndefined();
  });

  it("accepts and registers an unchanged signed operation policy from the loopback wire", async () => {
    const manifest = structuredClone(MANIFEST);
    const policy = {
      discriminant: "operation" as const,
      operations: {
        read: {
          kind: "read" as const,
          minimumRisk: "read" as const,
          appVisible: true,
        },
      },
    };
    manifest.tools[0] = {
      ...manifest.tools[0],
      inputSchema: {
        type: "object",
        properties: { operation: { const: "read" } },
        required: ["operation"],
        additionalProperties: false,
      },
      _meta: {
        ...manifest.tools[0]._meta,
        ui: { visibility: ["model", "app"] },
        "lvisai/operationPolicy": policy,
      },
    };
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      manifest,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
    );

    await publishTestHost(host, manifest.id, registry);

    expect(registry.findByName("notes_read")?.operationPolicy).toEqual(policy);
  });

  it("IGNORES the legacy xyz.lvis/rawResult — the dual-read was removed alongside the _meta rename", async () => {
    // rawResult is a DATA channel (not a security field), but the legacy read was
    // removed in the same sweep for consistency: a plugin emitting ONLY the legacy
    // key now surfaces NO metadata.rawResult (it must emit the new `lvisai/rawResult`).
    const delegate: PluginToolDelegate = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      _meta: { "xyz.lvis/rawResult": { note: "structured" } },
    }));
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ path: "/a.md" }, {} as never);
    expect(result.metadata).toBeUndefined();
  });

  it("reads the new lvisai/rawResult (and ignores a stray legacy key)", async () => {
    const delegate: PluginToolDelegate = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
      _meta: {
        "lvisai/rawResult": { from: "new" },
        "xyz.lvis/rawResult": { from: "legacy" },
      },
    }));
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ path: "/a.md" }, {} as never);
    expect((result.metadata as { rawResult?: unknown }).rawResult).toEqual({ from: "new" });
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
    const host = testLoopbackHost(
      MANIFEST,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
    );
    await publishTestHost(host, MANIFEST.id, registry);

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
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);

    const result = await registry.findByName("notes_read")!.execute({ path: "/x" }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("note locked");
  });

  it("retires through an inactive registry publication before transport disposal", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);
    expect(registry.findByName("notes_read")).toBeDefined();

    registry.reservePluginReplacement(MANIFEST.id, [], []).publish();
    await host.dispose();
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
    const host = testLoopbackHost(badManifest, delegate, registry);

    const registered = await publishTestHost(host, badManifest.id, registry);
    expect(registered).toEqual(["good_tool"]); // bad_tool dropped fail-soft
    expect(registry.findByName("bad_tool")).toBeUndefined();
  });

  it("rejects preparation after publication", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "ok" }] });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(MANIFEST, delegate, registry);
    await publishTestHost(host, MANIFEST.id, registry);
    await expect(host.prepareTools()).rejects.toThrow(/already started/);
  });

  it("readUiResource round-trips resources/read through the loopback to the provider", async () => {
    const provider = createPluginUiResourceProvider({
      pluginId: "com.example.notes",
      declarations: [
        {
          uri: "ui://com.example.notes/read.html",
          csp: { connectDomains: ["https://api.example.com"] },
        },
      ],
      readHtml: async () => "<h1>note</h1>",
    });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      MANIFEST,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
      provider,
    );
    await publishTestHost(host, MANIFEST.id, registry);

    const res = await host.readUiResource("ui://com.example.notes/read.html");
    expect(res).toEqual({
      html: "<h1>note</h1>",
      csp: { connectDomains: ["https://api.example.com"] },
    });
  });

  it("readUiResource rejects a cross-namespace uri (fail-closed, no served body)", async () => {
    const provider = createPluginUiResourceProvider({
      pluginId: "com.example.notes",
      declarations: [{ uri: "ui://com.example.notes/read.html" }],
      readHtml: async () => "<h1>note</h1>",
    });
    const registry = new ToolRegistry();
    const host = testLoopbackHost(
      MANIFEST,
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      registry,
      provider,
    );
    await publishTestHost(host, MANIFEST.id, registry);
    await expect(host.readUiResource("ui://other-plugin/read.html")).rejects.toThrow(/own namespace/i);
  });
});
