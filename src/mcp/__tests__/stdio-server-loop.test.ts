/**
 * stdio framing + StdioServerLoop (mcp-alignment-design.md §3.1
 * untrusted-stdio-isolation — the subprocess serving core).
 */
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { frameMessage, StdioFrameDecoder } from "../stdio-framing.js";
import { StdioServerLoop, type StdioRequestHandler } from "../experimental/stdio-server-loop.js";
import { PluginMcpServer, type PluginToolDelegate } from "../plugin-mcp-server.js";
import type { PluginManifest } from "../../plugins/types.js";

const MANIFEST: PluginManifest = {
  id: "com.example.fs",
  name: "FS",
  version: "1.0.0",
  entry: "dist/p.js",
  description: "files",
  tools: ["fs_read"],
  toolSchemas: {
    fs_read: {
      description: "Read a file",
      category: "read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
} as PluginManifest;

const RC_META = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };

describe("stdio-framing", () => {
  it("round-trips a message through frame → decode (byte-accurate)", () => {
    const decoder = new StdioFrameDecoder();
    const msg = { jsonrpc: "2.0", id: 1, method: "ping", params: { s: "유니코드 🚀" } };
    const out = decoder.push(frameMessage(msg));
    expect(out).toEqual([msg]);
  });

  it("buffers a frame split across chunks, then yields it whole", () => {
    const decoder = new StdioFrameDecoder();
    const framed = frameMessage({ jsonrpc: "2.0", id: 7, method: "m" });
    expect(decoder.push(framed.subarray(0, 10))).toEqual([]); // partial → nothing
    expect(decoder.push(framed.subarray(10))).toEqual([{ jsonrpc: "2.0", id: 7, method: "m" }]);
  });

  it("yields multiple frames arriving in one chunk", () => {
    const decoder = new StdioFrameDecoder();
    const both = Buffer.concat([
      frameMessage({ jsonrpc: "2.0", id: 1, method: "a" }),
      frameMessage({ jsonrpc: "2.0", id: 2, method: "b" }),
    ]);
    expect(decoder.push(both).map((m) => m.id)).toEqual([1, 2]);
  });

  it("skips a malformed body without throwing and recovers on the next frame", () => {
    const decoder = new StdioFrameDecoder();
    const bad = Buffer.from("Content-Length: 3\r\n\r\n{x{", "utf-8");
    const good = frameMessage({ jsonrpc: "2.0", id: 9, method: "ok" });
    expect(decoder.push(Buffer.concat([bad, good])).map((m) => m.id)).toEqual([9]);
  });
});

/** Read the next framed response off an output stream as a promise. */
function nextResponse(stream: PassThrough): Promise<Record<string, unknown>> {
  const decoder = new StdioFrameDecoder();
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      const msgs = decoder.push(chunk);
      if (msgs.length > 0) {
        stream.off("data", onData);
        resolve(msgs[0]);
      }
    };
    stream.on("data", onData);
  });
}

describe("StdioServerLoop — subprocess serving core over real streams", () => {
  function wire(delegate: PluginToolDelegate) {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new PluginMcpServer(MANIFEST, delegate);
    new StdioServerLoop(clientToServer, serverToClient, server).start();
    return { clientToServer, serverToClient };
  }

  it("answers server/discover over framed stdio", async () => {
    const delegate: PluginToolDelegate = async () => ({ content: [{ type: "text", text: "x" }] });
    const { clientToServer, serverToClient } = wire(delegate);

    const pending = nextResponse(serverToClient);
    clientToServer.write(frameMessage({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { ...RC_META } }));

    const res = await pending;
    expect(res.id).toBe(1);
    expect((res.result as { serverInfo: { name: string } }).serverInfo.name).toBe("FS");
  });

  it("dispatches tools/call to the delegate and frames the result", async () => {
    const delegate = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      content: [{ type: "text", text: `read ${(args as { path: string }).path}` }],
    }));
    const { clientToServer, serverToClient } = wire(delegate);

    const pending = nextResponse(serverToClient);
    clientToServer.write(
      frameMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fs_read", arguments: { path: "/etc/hosts" }, ...RC_META },
      }),
    );

    const res = await pending;
    expect(delegate).toHaveBeenCalledWith("fs_read", { path: "/etc/hosts" });
    expect(res.result).toMatchObject({
      resultType: "complete",
      content: [{ type: "text", text: "read /etc/hosts" }],
    });
  });

  it("a thrown handler becomes a JSON-RPC internal-error response, loop survives", async () => {
    const handler: StdioRequestHandler = {
      handle: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    };
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    new StdioServerLoop(clientToServer, serverToClient, handler).start();

    const pending = nextResponse(serverToClient);
    clientToServer.write(frameMessage({ jsonrpc: "2.0", id: 5, method: "tools/list" }));

    const res = await pending;
    expect(res.id).toBe(5);
    expect((res.error as { code: number; message: string }).code).toBe(-32603);
    expect((res.error as { message: string }).message).toBe("kaboom");
  });

  it("rejects double start", () => {
    const loop = new StdioServerLoop(new PassThrough(), new PassThrough(), {
      handle: async () => ({ jsonrpc: "2.0", id: 0, result: {} }),
    });
    loop.start();
    expect(() => loop.start()).toThrow(/already started/);
  });
});
