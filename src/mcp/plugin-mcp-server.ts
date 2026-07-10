/**
 * In-process MCP server for a single LVIS plugin (#1230, design §3.1/§3.3).
 *
 * This is the server half of "plugins as MCP servers": given a plugin manifest
 * and a delegate that actually runs a tool, it answers the MCP `2026-07-28` RC
 * request methods a plugin-server must implement — `server/discover`,
 * `tools/list`, and `tools/call` — using the pure projection in
 * `plugin-server-projection.ts`. It is transport-agnostic: it consumes a parsed
 * JSON-RPC request and returns a parsed JSON-RPC response, so it can be driven
 * by an in-process loopback transport (first-party plugins) or, later, a stdio
 * subprocess wrapper (out-of-process untrusted plugins) — the hybrid topology.
 *
 * Stateless (RC): there is no `initialize` handshake and no session. Every
 * request carries the client's identity/capabilities in `params._meta`; the
 * server validates only the protocol version here (capability gating arrives
 * with the `governance-per-request` milestone).
 */
import type { PluginManifest } from "../plugins/types.js";
import {
  manifestToDiscoverResult,
  manifestToolsToMcpTools,
} from "./plugin-server-projection.js";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";

const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32004;

/** One content block of a tool result (a 2026-07-28 `CallToolResult` content). */
export interface PluginToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** What a plugin's tool execution returns to the server. */
export interface PluginToolOutcome {
  content: PluginToolContent[];
  isError?: boolean;
  /** Optional MCP Apps `_meta.ui` extension passthrough. */
  _meta?: Record<string, unknown>;
}

/** Delegate that actually runs the plugin's tool (the plugin runtime supplies this). */
export type PluginToolDelegate = (
  name: string,
  args: Record<string, unknown>,
) => Promise<PluginToolOutcome>;

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

export class PluginMcpServer {
  constructor(
    private readonly manifest: PluginManifest,
    private readonly callTool: PluginToolDelegate,
  ) {}

  /**
   * Handle one JSON-RPC request and return its response. Tool-execution
   * failures surface as `isError: true` in a `complete` result (NOT a JSON-RPC
   * error) — matching the RC `CallToolResult` model; only protocol/dispatch
   * problems use JSON-RPC error codes.
   */
  async handle(request: JsonRpcRequestLike): Promise<JsonRpcResponseLike> {
    const id = request.id;

    const versionError = this.checkProtocolVersion(request.params);
    if (versionError) {
      return { jsonrpc: "2.0", id, error: versionError };
    }

    switch (request.method) {
      case "server/discover":
        return { jsonrpc: "2.0", id, result: manifestToDiscoverResult(this.manifest) };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete", tools: manifestToolsToMcpTools(this.manifest) },
        };

      case "tools/call": {
        const params = request.params ?? {};
        const name = params.name;
        if (typeof name !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: RPC_INVALID_PARAMS, message: "tools/call requires a string 'name'" },
          };
        }
        const args =
          params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          const outcome = await this.callTool(name, args);
          const result: Record<string, unknown> = {
            resultType: "complete",
            content: outcome.content,
          };
          if (outcome.isError !== undefined) result.isError = outcome.isError;
          if (outcome._meta !== undefined) result._meta = outcome._meta;
          return { jsonrpc: "2.0", id, result };
        } catch (err) {
          // A thrown delegate is a tool-execution failure → isError result, not
          // a JSON-RPC error (RC CallToolResult model).
          return {
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "complete",
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              isError: true,
            },
          };
        }
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: RPC_METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
        };
    }
  }

  /**
   * Validate the client's advertised protocol version (RC `_meta`). A request
   * with no `_meta` protocol version is tolerated (e.g. an internal caller);
   * an explicit mismatch is rejected with `-32004` per §8.
   */
  private checkProtocolVersion(
    params: Record<string, unknown> | undefined,
  ): { code: number; message: string; data?: unknown } | null {
    const meta = params?._meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    const requested = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
    if (requested === undefined) return null;
    if (requested === MCP_PROTOCOL_VERSION) return null;
    return {
      code: RPC_UNSUPPORTED_PROTOCOL_VERSION,
      message: `Unsupported protocol version: ${String(requested)}`,
      data: { supported: [MCP_PROTOCOL_VERSION], requested },
    };
  }
}
