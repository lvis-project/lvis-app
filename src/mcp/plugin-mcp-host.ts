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
 * sourced from the tool's `lvisai/*` `_meta`, never a second manifest read.
 */
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from "./mcp-client.js";
import { LoopbackTransport } from "./loopback-transport.js";
import { PluginMcpServer, type PluginToolDelegate } from "./plugin-mcp-server.js";
import type { PluginUiResourceProvider } from "./plugin-ui-resource-provider.js";
import { mcpToolToPluginTool, type DiscoveredMcpTool } from "./plugin-tool-from-mcp.js";
import { lintToolInputSchema } from "../plugins/tool-schema-lint.js";
import { createLogger } from "../lib/logger.js";
import { observeLegacyMetaKey } from "./legacy-meta-telemetry.js";
import type { Tool } from "../tools/base.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PluginManifest } from "../plugins/types.js";
import type { McpUiPayload, McpUiResourceMeta, McpUiResourceRead } from "./types.js";

const log = createLogger("plugin-mcp-host");

const MCP_PROTOCOL_VERSION = "2026-07-28";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const CLIENT_INFO = { name: "lvis-app", version: "0.1.0" } as const;
/** First-party host advertises elicitation; sampling/roots are deprecated (§8 SEP-2577). */
const CLIENT_CAPABILITIES = { elicitation: { form: {}, url: {} }, extensions: {} } as const;

/** Reserved `_meta` key carrying the plugin's raw (non-text) return value. */
const RAW_RESULT_META = "lvisai/rawResult";
/**
 * transitional: an out-of-process plugin / the SDK may still box its raw return
 * value under the legacy reverse-DNS key until they are migrated (then remove).
 */
const LEGACY_RAW_RESULT_META = "xyz.lvis/rawResult";

/** RC `CallToolResult` (the `complete` branch this host consumes). */
interface RcToolCallResult {
  resultType?: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  _meta?: {
    ui?: {
      resourceUri?: string;
      slot?: string;
      height?: number;
      title?: string;
      // No `csp` — per spec it lives on the RESOURCE, not the tool result.
    };
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
    uiResources?: PluginUiResourceProvider,
  ): PluginMcpHost {
    const server = new PluginMcpServer(manifest, delegate, uiResources);
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
    // ATOMIC reload: build the full tool set with NO registry mutation first
    // (buildTools is registry-read-only and throws on any authority failure), so
    // a failed reload leaves the PREVIOUS registration intact. Only once the new
    // set is known-good do we commit it in a single replacePluginTools swap —
    // there is never a window where the plugin has zero tools.
    const tools = await this.buildTools();
    this.toolRegistry.replacePluginTools([this.pluginId], tools);
    this.registeredToolNames.length = 0;
    this.registeredToolNames.push(...tools.map((t) => t.name));
    this.started = true;
    return [...this.registeredToolNames];
  }

  /**
   * Discover + project the plugin's tools into canonical {@link Tool}s WITHOUT
   * touching the ToolRegistry (so a prior registration survives a failed reload).
   * On any failure it closes ONLY this host's own transport and rethrows.
   */
  private async buildTools(): Promise<Tool[]> {
    this.transport.onMessage((msg) => this.handleResponse(msg));
    this.transport.onClose((reason) => this.failAllPending(reason));
    await this.transport.open();
    try {
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
      const tools: Tool[] = [];
      for (const tool of list.tools ?? []) {
        // Build FIRST — a structural hard failure THROWS here and aborts the
        // whole build (rollback). A missing/invalid lvisai/category no longer
        // hard-fails (host-classifies-risk: default-strict write-equivalent);
        // the remaining authority hard failure is the RC protocol mismatch
        // checked above.
        const registryTool = mcpToolToPluginTool(this.pluginId, tool, (name, args) =>
          this.invoke(name, args),
        );

        // THEN #1182 provider-strict lint, fail-soft per tool: a schema
        // OpenAI/Azure would 400 on (e.g. an `array` property with no `items`) is
        // dropped so one bad plugin tool can't take down every turn.
        const violations = lintToolInputSchema(tool.inputSchema);
        if (violations.length > 0) {
          log.warn(
            `plugin '${this.pluginId}' tool '${tool.name}' dropped — inputSchema fails LLM provider-strict lint: ${violations
              .map((v) => v.rule)
              .join(", ")}`,
          );
          continue;
        }
        tools.push(registryTool);
      }
      return tools;
    } catch (err) {
      // Registry-read-only path: nothing was registered, so the PREVIOUS plugin
      // registration (if any) is untouched. Close only this host's transport.
      await this.transport.close();
      throw err;
    }
  }

  /** Unregister the plugin's tools and close the transport. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.toolRegistry.unregisterByPlugin(this.pluginId);
    this.registeredToolNames.length = 0;
    this.started = false;
    await this.transport.close();
  }

  /**
   * Close the transport WITHOUT unregistering tools — for a host SUPERSEDED by an
   * atomic reload, where the new host's `replacePluginTools` swap already
   * installed the replacement tools (calling `stop()` here would wrongly delete
   * the freshly-installed set). Idempotent.
   */
  async dispose(): Promise<void> {
    if (!this.started) {
      await this.transport.close();
      return;
    }
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
          // No `csp` — spec puts it on the RESOURCE, and main derives it there.
        }
      : undefined;
    // Box the raw plugin return value iff the server included it (success path),
    // so the reverse adapter can re-surface metadata.rawResult with presence
    // preserved even when the value itself is undefined (a void plugin tool).
    // Prefer the new `lvisai/rawResult`; transitional: fall back to the legacy
    // `xyz.lvis/rawResult` until out-of-process plugins + the SDK are migrated.
    const meta = result._meta;
    let rawResult: { value: unknown } | undefined;
    if (meta && Object.prototype.hasOwnProperty.call(meta, RAW_RESULT_META)) {
      rawResult = { value: meta[RAW_RESULT_META] };
    } else if (meta && Object.prototype.hasOwnProperty.call(meta, LEGACY_RAW_RESULT_META)) {
      observeLegacyMetaKey(this.pluginId, "rawResult");
      rawResult = { value: meta[LEGACY_RAW_RESULT_META] };
    } else {
      rawResult = undefined;
    }
    return { text, uiPayload, rawResult };
  }

  /**
   * Fetch one of THIS plugin's declared `ui://` resources over the loopback
   * transport (`resources/read`) — the plugin arm of the MCP App serving seam.
   * Returns the HTML plus the resource's OWN `_meta.ui` (its csp),
   * from which main derives the sandbox-proxy CSP header. Mirrors
   * {@link McpClient.readResource} so the render path is transport-agnostic.
   *
   * Fail-closed: the server rejects an undeclared / cross-namespace uri with a
   * JSON-RPC error, which surfaces here as a rejected promise (never a body).
   */
  async readUiResource(uri: string): Promise<McpUiResourceRead> {
    const result = (await this.request("resources/read", { uri })) as {
      contents?: Array<{ text?: string; _meta?: { ui?: McpUiResourceMeta } }>;
    };
    const textPart = result.contents?.find((c) => typeof c.text === "string");
    if (!textPart?.text) {
      throw new Error(
        `[plugin-mcp-host] resource '${uri}' on '${this.pluginId}' returned no text content`,
      );
    }
    const ui = textPart._meta?.ui;
    return { html: textPart.text, csp: ui?.csp };
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
