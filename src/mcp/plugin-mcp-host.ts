/**
 * `PluginMcpHost` — one LVIS plugin running as an MCP server behind a lean,
 * in-process RC client (mcp-alignment-design.md §3.1, the first-party arm of the
 * hybrid topology).
 *
 * Why this is NOT `McpClient`: design §0 decision (3) confines `mcp-client.ts`
 * to EXTERNAL/untrusted servers and the documented dual-era (`2024-11-05`)
 * fallback exception. A first-party plugin is RC-only — it never speaks the
 * legacy protocol — and registers with PLUGIN authority (its declared category,
 * natural tool name, `source:"plugin"`), not the external `category:"network"` +
 * `mcp_` namespace. Carrying the external client's dual-era branches into the
 * plugin path would be exactly the No-Fallback violation this initiative
 * removes, so the plugin path gets its own minimal RC client here.
 *
 * It speaks RC JSON-RPC over an injected {@link McpTransport}: a
 * {@link LoopbackTransport} for first-party plugins now, and (at the
 * `untrusted-stdio-isolation` milestone) a stdio transport for sandboxed
 * marketplace plugins — the SAME host, a different transport. Registration runs
 * through MCP discovery (`server/discover` + `tools/list`) and the reverse
 * projection {@link mcpToolToPluginTool}, so the authoritative `category` is
 * sourced from the tool's `xyz.lvis/*` `_meta`, never a second manifest read.
 */
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from "./mcp-client.js";
import { LoopbackTransport } from "./loopback-transport.js";
import { PluginMcpServer, type PluginToolDelegate } from "./plugin-mcp-server.js";
import { mcpToolToPluginTool, type DiscoveredMcpTool } from "./plugin-tool-from-mcp.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PluginManifest } from "../plugins/types.js";
import type { McpUiPayload } from "./types.js";

const MCP_PROTOCOL_VERSION = "2026-07-28";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const CLIENT_INFO = { name: "lvis-app", version: "0.1.0" } as const;
/** First-party host advertises elicitation; sampling/roots are deprecated (§8 SEP-2577). */
const CLIENT_CAPABILITIES = { elicitation: { form: {}, url: {} }, extensions: {} } as const;

/** Reserved `_meta` key carrying the plugin's raw (non-text) return value. */
const RAW_RESULT_META = "xyz.lvis/rawResult";

/** RC `CallToolResult` (the `complete` branch this host consumes). */
interface RcToolCallResult {
  resultType?: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  _meta?: {
    ui?: { resourceUri?: string; slot?: string; height?: number; title?: string };
    [key: string]: unknown;
  };
}

function renderContent(content: RcToolCallResult["content"]): string {
  return content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
}

export class PluginMcpHost {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private started = false;
  private readonly registeredToolNames: string[] = [];

  constructor(
    private readonly pluginId: string,
    private readonly transport: McpTransport,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  /**
   * Build a loopback-backed host for a first-party plugin: the plugin's tool
   * runtime is supplied as `delegate` (what actually executes `tools/call`); the
   * manifest is projected into the in-process {@link PluginMcpServer}.
   */
  static loopback(
    manifest: PluginManifest,
    delegate: PluginToolDelegate,
    toolRegistry: ToolRegistry,
  ): PluginMcpHost {
    const server = new PluginMcpServer(manifest, delegate);
    return new PluginMcpHost(manifest.id, new LoopbackTransport(server), toolRegistry);
  }

  /**
   * Open the transport, discover the plugin's RC server, and register its tools
   * into the {@link ToolRegistry}. Returns the registered (natural, un-namespaced)
   * tool names. Fail-closed: a plugin server that does not advertise the RC
   * protocol version is rejected (No-Fallback — first-party plugins are RC-only).
   */
  async start(): Promise<string[]> {
    if (this.started) {
      throw new Error(`[plugin-mcp-host] '${this.pluginId}' already started`);
    }
    this.transport.onMessage((msg) => this.handleResponse(msg));
    this.transport.onClose((reason) => this.failAllPending(reason));
    await this.transport.open();

    const discover = (await this.request("server/discover", {})) as {
      supportedVersions?: string[];
    };
    if (!discover.supportedVersions?.includes(MCP_PROTOCOL_VERSION)) {
      throw new Error(
        `[plugin-mcp-host] plugin '${this.pluginId}' did not advertise RC protocol ${MCP_PROTOCOL_VERSION} ` +
          `(got ${JSON.stringify(discover.supportedVersions)}); first-party plugins are RC-only.`,
      );
    }

    const list = (await this.request("tools/list", {})) as { tools?: DiscoveredMcpTool[] };
    try {
      for (const tool of list.tools ?? []) {
        const registryTool = mcpToolToPluginTool(this.pluginId, tool, (name, args) =>
          this.invoke(name, args),
        );
        this.toolRegistry.register(registryTool);
        this.registeredToolNames.push(registryTool.name);
      }
    } catch (err) {
      // Any tool's authority projection failing fails the whole start closed —
      // leave no half-registered plugin behind.
      this.toolRegistry.unregisterByPlugin(this.pluginId);
      this.registeredToolNames.length = 0;
      await this.transport.close();
      throw err;
    }

    this.started = true;
    return [...this.registeredToolNames];
  }

  /** Unregister the plugin's tools and close the transport. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.toolRegistry.unregisterByPlugin(this.pluginId);
    this.registeredToolNames.length = 0;
    this.started = false;
    await this.transport.close();
  }

  /** Execute one tool via `tools/call` over the transport (the reverse adapter's delegate). */
  private async invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; uiPayload?: McpUiPayload; rawResult?: { value: unknown } }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as RcToolCallResult;

    // RC result discriminator (§8). MRTR / Tasks are later milestones — surface a
    // real typed error rather than degrading silently (No-Fallback).
    if (result.resultType === "input_required") {
      throw new Error(
        `[plugin-mcp-host] tool '${name}' on '${this.pluginId}' returned resultType="input_required" — the MRTR input loop is not implemented yet (milestone mrtr-input-loop)`,
      );
    }
    if (result.resultType === "task") {
      throw new Error(
        `[plugin-mcp-host] tool '${name}' on '${this.pluginId}' returned resultType="task" — the Tasks extension is not implemented yet (milestone tasks-extension)`,
      );
    }
    if (result.isError) {
      throw new Error(renderContent(result.content));
    }

    const text = renderContent(result.content);
    const uiMeta = result._meta?.ui;
    const uiPayload: McpUiPayload | undefined = uiMeta?.resourceUri
      ? {
          serverId: this.pluginId,
          resourceUri: uiMeta.resourceUri,
          slot: (uiMeta.slot as McpUiPayload["slot"]) ?? "chat",
          height: uiMeta.height,
          title: uiMeta.title,
        }
      : undefined;
    // Box the raw plugin return value iff the server included it (success path),
    // so the reverse adapter can re-surface metadata.rawResult with presence
    // preserved even when the value itself is undefined (a void plugin tool).
    const rawResult =
      result._meta && Object.prototype.hasOwnProperty.call(result._meta, RAW_RESULT_META)
        ? { value: result._meta[RAW_RESULT_META] }
        : undefined;
    return { text, uiPayload, rawResult };
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: this.withRequestMeta(params),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(request).catch((err: unknown) => {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Stamp the three reserved RC `_meta` keys required on every request (§8). */
  private withRequestMeta(params: Record<string, unknown>): Record<string, unknown> {
    return {
      ...params,
      _meta: {
        [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
        [META_CLIENT_INFO]: CLIENT_INFO,
        [META_CLIENT_CAPABILITIES]: CLIENT_CAPABILITIES,
      },
    };
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error.message));
    } else {
      entry.resolve(msg.result);
    }
  }

  private failAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error(`[plugin-mcp-host] '${this.pluginId}' transport closed: ${reason}`));
    }
    this.pending.clear();
  }
}
