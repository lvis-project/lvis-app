import { describe, it, expect, vi } from "vitest";
import { PluginMcpServer, type PluginToolDelegate } from "../plugin-mcp-server.js";
import { createPluginUiResourceProvider } from "../plugin-ui-resource-provider.js";
import type { PluginManifest } from "../../plugins/types.js";

const MANIFEST: PluginManifest = {
  id: "com.example.fs",
  name: "FS",
  version: "1.0.0",
  entry: "dist/p.js",
  description: "files",
  tools: [
    {
      name: "fs_read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      _meta: { ui: { visibility: ["model"] } },
    },
  ],
};

function req(method: string, params?: Record<string, unknown>) {
  return { jsonrpc: "2.0" as const, id: 1, method, params };
}

const RC_META = {
  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
};

describe("PluginMcpServer — RC server methods (#1230 §3.1)", () => {
  const delegate: PluginToolDelegate = vi.fn(async () => ({
    content: [{ type: "text", text: "file-body" }],
  }));
  const server = new PluginMcpServer(MANIFEST, delegate);

  it("answers server/discover from the manifest projection", async () => {
    const res = await server.handle(req("server/discover", { ...RC_META }));
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      serverInfo: { name: "FS", version: "1.0.0" },
      capabilities: { tools: { listChanged: true } },
    });
  });

  it("answers tools/list with projected tools (explicit _meta.ui.visibility, no wire category)", async () => {
    const res = (await server.handle(req("tools/list", { ...RC_META }))).result as {
      resultType: string;
      tools: Array<{ name: string; _meta: Record<string, unknown> }>;
    };
    expect(res.resultType).toBe("complete");
    expect(res.tools.map((t) => t.name)).toEqual(["fs_read"]);
    // #885 v6 — visibility is emitted explicitly; category is REMOVED from the wire.
    expect((res.tools[0]._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["model"]);
    expect(res.tools[0]._meta["lvisai/category"]).toBeUndefined();
  });

  it("dispatches tools/call to the delegate and wraps a complete CallToolResult", async () => {
    const res = await server.handle(
      req("tools/call", { name: "fs_read", arguments: { path: "/a" }, ...RC_META }),
    );
    expect(delegate).toHaveBeenCalledWith("fs_read", { path: "/a" });
    expect(res.result).toEqual({
      resultType: "complete",
      content: [{ type: "text", text: "file-body" }],
    });
  });

  it("surfaces a thrown delegate as isError content (not a JSON-RPC error)", async () => {
    const boom: PluginToolDelegate = async () => {
      throw new Error("disk full");
    };
    const res = await new PluginMcpServer(MANIFEST, boom).handle(
      req("tools/call", { name: "fs_read", arguments: {}, ...RC_META }),
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: "disk full" }],
    });
  });

  it("rejects tools/call without a string name (-32602)", async () => {
    const res = await server.handle(req("tools/call", { ...RC_META }));
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32602);
  });

  it("returns -32601 for an unknown method", async () => {
    const res = await server.handle(req("frobnicate", { ...RC_META }));
    expect(res.error?.code).toBe(-32601);
  });

  it("rejects an unsupported protocol version in _meta (-32004)", async () => {
    const res = await server.handle(
      req("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2024-11-05" } }),
    );
    expect(res.error?.code).toBe(-32004);
    expect(res.error?.data).toMatchObject({ supported: ["2026-07-28"], requested: "2024-11-05" });
  });

  it("tolerates a request with no _meta protocol version (internal caller)", async () => {
    const res = await server.handle(req("tools/list"));
    expect(res.error).toBeUndefined();
  });
});

describe("PluginMcpServer — resources/read + resources/list (ui:// serving seam)", () => {
  const delegate: PluginToolDelegate = vi.fn(async () => ({
    content: [{ type: "text", text: "unused" }],
  }));
  const CARD_URI = "ui://com.example.fs/card.html";
  const provider = createPluginUiResourceProvider({
    pluginId: "com.example.fs",
    declarations: [{ uri: CARD_URI, csp: { connectDomains: ["https://api.example.com"] } }],
    readHtml: async () => "<h1>card</h1>",
  });

  it("serves a declared ui:// resource with mcp-app mime + the resource's own _meta.ui csp", async () => {
    const server = new PluginMcpServer(MANIFEST, delegate, provider);
    const res = await server.handle(req("resources/read", { uri: CARD_URI, ...RC_META }));
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      resultType: "complete",
      contents: [
        {
          uri: CARD_URI,
          mimeType: "text/html;profile=mcp-app",
          text: "<h1>card</h1>",
          _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] } } },
        },
      ],
    });
  });

  it("rejects a cross-plugin uri authority with -32002 (own-namespace-only, fail-closed)", async () => {
    const server = new PluginMcpServer(MANIFEST, delegate, provider);
    const res = await server.handle(
      req("resources/read", { uri: "ui://other-plugin/card.html", ...RC_META }),
    );
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32002);
  });

  it("rejects resources/read without a string uri (-32602)", async () => {
    const server = new PluginMcpServer(MANIFEST, delegate, provider);
    const res = await server.handle(req("resources/read", { ...RC_META }));
    expect(res.error?.code).toBe(-32602);
  });

  it("fails-closed with -32002 when the plugin serves NO ui:// resources (no provider)", async () => {
    const server = new PluginMcpServer(MANIFEST, delegate);
    const res = await server.handle(req("resources/read", { uri: CARD_URI, ...RC_META }));
    expect(res.error?.code).toBe(-32002);
  });

  it("lists declared resources; empty when no provider", async () => {
    const withProvider = new PluginMcpServer(MANIFEST, delegate, provider);
    const listed = (await withProvider.handle(req("resources/list", { ...RC_META }))).result as {
      resources: Array<{ uri: string; mimeType: string }>;
    };
    expect(listed.resources).toEqual([{ uri: CARD_URI, mimeType: "text/html;profile=mcp-app" }]);

    const noProvider = new PluginMcpServer(MANIFEST, delegate);
    const empty = (await noProvider.handle(req("resources/list", { ...RC_META }))).result as {
      resources: unknown[];
    };
    expect(empty.resources).toEqual([]);
  });
});
