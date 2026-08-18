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
 *
 * Both directions are JSON round-tripped, and a value that would not survive
 * that round-trip UNCHANGED is refused rather than converted. Passing object
 * references made this look like a boundary without being one: a plugin could
 * return a `Date`, a `Map`, a class instance or a live mutable object and the
 * host received that exact reference, so the MCP framing proved nothing about
 * whether the same call works over a real wire.
 *
 * Refusing rather than converting is the point. Round-tripping alone would
 * make both sides agree on the mangled shape — `Buffer` becomes
 * `{ type: "Buffer", data: number[] }` without an exception — and a silent
 * type change passes every test here and misbehaves once the plugin is out of
 * process. The error names the exact path (`result.items[3].createdAt: Date`)
 * because "something was unserializable" is not something anyone can act on.
 */
import type {
  JsonRpcMessage,
  JsonRpcResponse,
  McpTransport,
} from "./mcp-client.js";
import type { PluginMcpServer } from "./plugin-mcp-server.js";
import { describeNonJson } from "../shared/json-representable.js";

/**
 * Round-trip a value the way a real transport would, refusing anything the
 * round-trip would not preserve.
 *
 * `direction` and `id` go into the message because by the time a malformed
 * payload is noticed, the only context left is which hop it was on.
 */
function marshal<T>(value: T, direction: string, id: unknown): T {
  const reason = describeNonJson(value, direction);
  if (reason !== null) {
    throw new Error(
      `[loopback] ${direction} for request ${String(id)} does not survive a JSON round-trip: ${reason}. ` +
        "Loopback is in-process, so this call works here and breaks over a real transport; " +
        "give the value a JSON representation at its source rather than relying on the shared heap.",
    );
  }
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

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
    // (`method` is optional on every union arm now, so narrow by value.)
    const method = "method" in message ? message.method : undefined;
    if (typeof method !== "string" || !("id" in message)) {
      return;
    }
    const response = await this.server.handle({
      jsonrpc: "2.0",
      id: message.id,
      method,
      // Params cross the boundary too. A caller handing the server a live
      // object would otherwise have the server mutate the caller's copy.
      params: marshal(message.params, "params", message.id),
    });
    const result = marshal(response.result, "result", message.id);
    const error = marshal(response.error, "error", message.id);
    queueMicrotask(() => {
      this.messageHandler?.({ jsonrpc: "2.0", id: message.id, result, error });
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
