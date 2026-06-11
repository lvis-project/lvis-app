/**
 * In-process loopback {@link McpTransport} (#1230, design §3.1 hybrid topology).
 *
 * Bridges a {@link McpClient} to a {@link PluginMcpServer} running in the SAME
 * process, with no sockets/subprocess — the first-party plugin path. The client
 * issues real RC JSON-RPC requests; this transport hands each request to the
 * server's `handle()` and pipes the response back through `onMessage`. Out-of-
 * process untrusted plugins use a stdio wrapper instead (same server, different
 * transport).
 *
 * Responses are delivered on a microtask (not synchronously inside `send`) so
 * the client's pending-request map is registered before the reply arrives —
 * matching the async delivery contract of the stdio/HTTP transports.
 */
import type {
  JsonRpcMessage,
  JsonRpcResponse,
  McpTransport,
} from "./mcp-client.js";
import type { PluginMcpServer } from "./plugin-mcp-server.js";

export class LoopbackTransport implements McpTransport {
  readonly kind = "loopback" as const;

  private alive = false;
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;

  constructor(private readonly server: PluginMcpServer) {}

  async open(): Promise<void> {
    this.alive = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.alive) {
      throw new Error("[loopback] transport not open");
    }
    // Only requests (have both `method` and `id`) get a reply; notifications
    // (method, no id) are fire-and-forget; responses never travel client→server.
    if (!("method" in message) || !("id" in message)) {
      return;
    }
    const response = await this.server.handle({
      jsonrpc: "2.0",
      id: message.id,
      method: message.method,
      params: message.params,
    });
    queueMicrotask(() => {
      this.messageHandler?.({
        jsonrpc: "2.0",
        id: message.id,
        result: response.result,
        error: response.error,
      });
    });
  }

  async close(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.closeHandler?.("loopback closed");
  }

  isAlive(): boolean {
    return this.alive;
  }

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }
}
