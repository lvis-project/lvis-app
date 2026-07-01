/**
 * Experimental `StdioServerLoop` — the subprocess-side serving core of the
 * out-of-process plugin path (mcp-alignment-design.md §3.1,
 * `untrusted-stdio-isolation`).
 *
 * This is what runs INSIDE a spawned, sandboxed plugin process: it reads
 * Content-Length-framed JSON-RPC requests from an input stream (the subprocess's
 * stdin), dispatches each to a {@link PluginMcpServer}-shaped handler, and writes
 * the framed response to an output stream (stdout). The host side drives it via a
 * stdio transport (the untrusted arm of the hybrid topology), exactly as the
 * loopback transport drives the in-process server for first-party plugins — same
 * `PluginMcpServer`, same projection, different transport.
 *
 * Transport-agnostic above the framing: it takes plain Node streams, so it is
 * tested over in-memory paired streams without spawning a real process. The
 * subprocess spawner + OS sandbox (the Anthropic Sandbox Runtime — macOS
 * Seatbelt / Linux bwrap) + the signed
 * spawnable-artifact format are the REMAINING `untrusted-stdio-isolation` work
 * (the artifact format is the §6 open decision) and sit above this loop.
 *
 * Robustness: a handler that throws does not kill the loop — it emits a JSON-RPC
 * internal-error response for that request and keeps serving (a buggy tool must
 * not take the whole server down).
 */
import type { Readable, Writable } from "node:stream";
import { frameMessage, StdioFrameDecoder } from "../stdio-framing.js";

const RPC_INTERNAL_ERROR = -32603;

interface JsonRpcRequestLike {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponseLike {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** What the loop dispatches each request to (a {@link PluginMcpServer} satisfies this). */
export interface StdioRequestHandler {
  handle(request: JsonRpcRequestLike): Promise<JsonRpcResponseLike>;
}

export class StdioServerLoop {
  private readonly decoder = new StdioFrameDecoder();
  private started = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handler: StdioRequestHandler,
  ) {}

  /** Begin consuming framed requests from the input stream. */
  start(): void {
    if (this.started) {
      throw new Error("[stdio-server-loop] already started");
    }
    this.started = true;
    this.input.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    for (const message of this.decoder.push(chunk)) {
      // Only requests (method + id) get a reply; notifications (method, no id)
      // are fire-and-forget and a bare response is ignored.
      if (typeof message.method === "string" && message.id !== undefined) {
        void this.dispatch(message as unknown as JsonRpcRequestLike);
      }
    }
  }

  private async dispatch(request: JsonRpcRequestLike): Promise<void> {
    let response: JsonRpcResponseLike;
    try {
      response = await this.handler.handle(request);
    } catch (err) {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RPC_INTERNAL_ERROR,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    this.output.write(frameMessage(response));
  }
}
