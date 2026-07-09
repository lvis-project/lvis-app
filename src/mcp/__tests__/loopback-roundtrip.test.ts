/**
 * End-to-end proof of the "plugin as MCP server" round-trip (#1230):
 * a LVIS plugin manifest → PluginMcpServer → LoopbackTransport → McpClient →
 * discovered tools registered in the ToolRegistry → tools/call delegated back.
 * No sockets, no subprocess — the first-party in-process path.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { McpClient } from "../mcp-client.js";
import { ToolRegistry } from "../../tools/registry.js";
import { PluginMcpServer, type PluginToolDelegate } from "../plugin-mcp-server.js";
import { LoopbackTransport } from "../loopback-transport.js";
import type { McpGovernancePolicy } from "../types.js";
import type { NormalizedManifest } from "../../plugins/types.js";
import { governanceWithPolicy } from "./test-helpers.js";

afterEach(() => vi.restoreAllMocks());

function approvingPolicy(id: string, command: string): McpGovernancePolicy {
  return {
    version: "1.0-test",
    defaultPolicy: "deny",
    servers: [
      {
        id,
        name: id,
        status: "approved",
        transport: "stdio",
        allowedCommands: [command],
        requiredAuth: "none",
        tlsRequired: false,
        allowedCapabilities: ["tools"],
        maxTools: 16,
        toolNamePrefix: id,
        toolPermissionMode: "default",
        connectionTimeoutMs: 5_000,
        maxConcurrentRequests: 4,
      },
    ],
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      policyRefreshIntervalMs: 60_000,
    },
  };
}

const MANIFEST: NormalizedManifest = {
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

describe("plugin-as-MCP-server loopback round-trip (#1230)", () => {
  it("discovers + registers a plugin's tools and round-trips a tools/call over loopback", async () => {
    const delegate: PluginToolDelegate = vi.fn(async (_name, args) => ({
      content: [{ type: "text", text: `read ${(args as { path?: string }).path ?? "?"}` }],
    }));
    const server = new PluginMcpServer(MANIFEST, delegate);
    const transport = new LoopbackTransport(server);

    const registry = new ToolRegistry();
    const client = new McpClient(
      // The config's transport/command satisfy governance; the actual transport
      // is the injected loopback (5th ctor arg) — the in-process plugin path.
      { id: "fs", transport: "stdio", command: "lvis-mcp-fs" },
      governanceWithPolicy(approvingPolicy("fs", "lvis-mcp-fs")),
      registry,
      undefined,
      transport,
    );

    await client.connect();

    // RC discover + tools/list ran over the loopback; the tool is registered
    // under the client's mcp_{serverId}_{toolName} namespace (id "fs" + "fs_read").
    expect(client.getState().status).toBe("connected");
    expect(client.getState().registeredTools).toEqual(["mcp_fs_fs_read"]);

    // tools/call round-trips client → loopback → server → delegate → back.
    const out = await client.callTool("fs_read", { path: "/etc/hosts" });
    expect(out).toEqual({ text: "read /etc/hosts", uiPayload: undefined });
    expect(delegate).toHaveBeenCalledWith("fs_read", { path: "/etc/hosts" });

    await client.disconnect();
    expect(client.getState().status).toBe("disconnected");
  });
});
