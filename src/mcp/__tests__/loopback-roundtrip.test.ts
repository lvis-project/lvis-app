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
import type { PluginManifest } from "../../plugins/types.js";
import { governanceWithPolicy } from "./test-helpers.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";

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
      // is the injected loopback (6th ctor arg) — the in-process plugin path.
      { id: "fs", transport: "stdio", command: "lvis-mcp-fs" },
      governanceWithPolicy(approvingPolicy("fs", "lvis-mcp-fs")),
      registry,
      unusedNetworkFetch,
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

describe("loopback marshalling — the boundary has to behave like a wire", () => {
  /**
   * The transport used to hand `response.result` back BY REFERENCE, so a
   * plugin could return a `Date`, a `Map`, a class instance or a live mutable
   * object and the host received that exact object. The MCP framing looked
   * like a boundary and proved nothing about whether the call survives a real
   * transport.
   *
   * These pin refusal rather than conversion. Round-tripping alone would make
   * both sides agree on the mangled shape — a `Buffer` becomes
   * `{ type: "Buffer", data: number[] }` with no exception — and a silent type
   * change passes every test in this file and misbehaves once the plugin is
   * out of process.
   */
  async function connectWith(result: unknown) {
    const delegate: PluginToolDelegate = vi.fn(async () => result as never);
    const transport = new LoopbackTransport(new PluginMcpServer(MANIFEST, delegate));
    const client = new McpClient(
      { id: "fs", transport: "stdio", command: "lvis-mcp-fs" },
      governanceWithPolicy(approvingPolicy("fs", "lvis-mcp-fs")),
      new ToolRegistry(),
      unusedNetworkFetch,
      undefined,
      transport,
    );
    await client.connect();
    return client;
  }

  /**
   * The plugin's own return value travels in `_meta["lvisai/rawResult"]` — the
   * server forwards only `content`, `isError` and `_meta`, so that is the
   * channel an arbitrary plugin value actually takes.
   */
  const rawResult = (value: unknown) => ({
    content: [{ type: "text", text: "ok" }],
    _meta: { "lvisai/rawResult": { value } },
  });

  it.each([
    ["a Date", () => new Date("2026-01-01T00:00:00Z"), "Date"],
    ["a Map", () => new Map([["a", 1]]), "Map"],
    ["a Set", () => new Set([1]), "Set"],
    ["a URL", () => new URL("https://example.test/x"), "URL"],
    ["a Buffer", () => Buffer.from("hi"), "Buffer"],
    ["a class instance", () => new (class Session { id = 1; })(), "Session"],
  ])("refuses %s in a tool result, naming what it found", async (_label, make, expected) => {
    const client = await connectWith(rawResult(make()));
    await expect(client.callTool("fs_read", { path: "/x" })).rejects.toThrow(expected);
    await client.disconnect();
  });

  it("names the PATH to the offending value, not just its type", async () => {
    // "something was unserializable" is not actionable. The path is what makes
    // it possible to find the line that produced it.
    const client = await connectWith(rawResult({ items: [{ ok: 1 }, { createdAt: new Date() }] }));
    await expect(client.callTool("fs_read", { path: "/x" })).rejects.toThrow(/items\[1\]\.createdAt/);
    await client.disconnect();
  });

  it("refuses undefined inside an ARRAY, where it changes the value", async () => {
    // Distinct from an undefined property, which means "absent" and is dropped
    // as intended. In an array the length is kept and one element silently
    // becomes null, so a consumer reading that null as data is wrong with
    // nothing raised.
    const client = await connectWith(rawResult({ items: [1, undefined, 2] }));
    await expect(client.callTool("fs_read", { path: "/x" })).rejects.toThrow(/items\[1\].*undefined in an array/);
    await client.disconnect();
  });

  it("still accepts an undefined PROPERTY, which is how a contract says absent", async () => {
    const client = await connectWith(rawResult({ id: 1, detail: undefined }));
    await expect(client.callTool("fs_read", { path: "/x" })).resolves.toBeDefined();
    await client.disconnect();
  });

  it("refuses a non-finite number, which JSON.stringify turns into null", async () => {
    // Not an exception case for JSON.stringify — it emits `null`, so the
    // round-trip "succeeds" into a different value.
    //
    // NaN is how a handler arrives here in practice rather than something one
    // returns on purpose: `meeting_push_chunk` validates only `sessionId` and
    // `!!chunk`, so an omitted `startSec` reaches `undefined + number`, is
    // stored on the segment, and is refused on a later transcript read. The
    // value is written directly because the arithmetic that produces it is the
    // plugin's bug, not this test's subject.
    const client = await connectWith(rawResult({ segments: [{ startSec: Number.NaN, text: "hi" }] }));
    await expect(client.callTool("fs_read", { path: "/x" })).rejects.toThrow(
      /segments\[0\]\.startSec.*non-finite/,
    );
    await client.disconnect();
  });

  it("passes a plain JSON result through unchanged", async () => {
    const client = await connectWith(rawResult({ items: [{ id: 1, tags: ["a"], nested: { ok: true } }] }));
    await expect(client.callTool("fs_read", { path: "/x" })).resolves.toBeDefined();
    await client.disconnect();
  });

  it("hands the host a COPY, so a plugin cannot mutate what the host already read", async () => {
    // Asserted at the transport, because `callTool` returns only the model-
    // facing text — the reference pass-through is not observable through it.
    //
    // The two sides used to share one object, so a plugin holding that
    // reference could change a value the host had already acted on.
    const live = { items: [{ id: 1 }] };
    const delegate: PluginToolDelegate = vi.fn(async () => rawResult(live) as never);
    const transport = new LoopbackTransport(new PluginMcpServer(MANIFEST, delegate));

    const received: unknown[] = [];
    transport.onMessage((msg) => received.push(msg.result));
    await transport.open();
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "fs_read", arguments: { path: "/x" } },
    });
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));

    const delivered = received[0] as { _meta: { "lvisai/rawResult": { value: { items: { id: number }[] } } } };
    expect(delivered._meta["lvisai/rawResult"].value.items[0]!.id).toBe(1);

    live.items[0]!.id = 999;
    expect(delivered._meta["lvisai/rawResult"].value.items[0]!.id).toBe(1);

    await transport.close();
  });
});
