/**
 * Unified `serverId → MCP UI backend` resolver — the SINGLE source of truth for
 * WHICH backend serves a card: its `ui://` resource render AND its app-initiated
 * `tools/call` (`oncalltool`). It replaced the former external-only resolution
 * inline in the `readUiResource` IPC handler so the render path and the call path
 * share ONE resolution rule, never a duplicated `serverId → backend` branch.
 *
 * Resolution order — LOOPBACK FIRST, then external:
 *  1. A first-party plugin runs as an in-process loopback MCP server whose
 *     `serverId === pluginId` (`PluginLoopbackManager`). It is NEVER in
 *     `mcpManager.clients` (external-only), so it must be tried first.
 *  2. Otherwise fall back to the external MCP client registry
 *     (`McpManager.readUiResource`), which itself fails-closed ("server not
 *     found") on an unknown id.
 *
 * There is exactly ONE `sources.loopback.has(serverId)` branch in this file and
 * nowhere else; every method of the returned backend is bound to the SAME chosen
 * source and the SAME serverId. No consumer branches on backend kind — that is
 * the whole point of the seam.
 *
 * `resolveToolOwner` + `callTool` are the `oncalltool` half (the tool-call source
 * implementations live in `mcp-ui-tool-call.ts`).
 */
import type { McpUiResourceRead } from "./types.js";

/** A resolved backend that serves ONE card: its `ui://` resource + its own tools. */
export interface McpUiBackend {
  /** Read one `ui://` resource: HTML + the resource's OWN declared csp/permissions. */
  readUiResource(uri: string): Promise<McpUiResourceRead>;
  /**
   * Which server owns `toolName` in THIS backend's registry — `undefined` when it
   * knows no such tool. The `oncalltool` IPC handler compares it against the card's
   * serverId ONCE (the tool-owner == serverId invariant); no backend re-derives it.
   */
  resolveToolOwner(toolName: string): string | undefined;
  /**
   * Return the plugin-owned governed write that needs a Host-issued one-shot
   * operation grant, or `undefined` when this invocation is not such a write.
   * The returned identity is derived from the registry, never from the app.
   */
  resolveOperationGrantTarget(
    toolName: string,
    args: Record<string, unknown>,
  ): { pluginId: string; toolName: string } | undefined;
  /**
   * Invoke `toolName` through the host's EXISTING gated tool path (risk
   * classification → reviewer/approval → audit). Never a raw `mcpManager.callTool`
   * / raw plugin handler call: both source implementations funnel into the
   * ToolExecutor. Rejects when the tool is not app-callable (the spec's
   * `_meta.ui.visibility` MUST) or the gate denies it.
   */
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    invocation: { appSessionId: string; operationGrantToken?: string },
  ): Promise<unknown>;
}

/**
 * The external surface this resolver needs (an `McpManager` subset + the gated
 * external tool-call source from `mcp-ui-tool-call.ts`).
 */
export interface ExternalUiSource {
  readUiResource(serverId: string, uri: string): Promise<McpUiResourceRead>;
  resolveToolOwner(serverId: string, toolName: string): string | undefined;
  resolveOperationGrantTarget(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): { pluginId: string; toolName: string } | undefined;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    invocation: { appSessionId: string; operationGrantToken?: string },
  ): Promise<unknown>;
}

/**
 * The loopback surface this resolver needs (a `PluginLoopbackManager` subset + the
 * plugin-runtime tool-call source). Same shape as {@link ExternalUiSource} plus the
 * `has()` predicate that decides the ONE branch below — so both arms are
 * interchangeable to `resolveMcpUiBackend`.
 */
export interface LoopbackUiSource extends ExternalUiSource {
  has(serverId: string): boolean;
}

/**
 * Resolve the backend that owns `serverId`: the plugin loopback host when one is
 * running for that id, else the external MCP client registry. The returned backend
 * closes over `serverId`, so callers pass only the `uri` / tool name — the card's
 * server is bound HERE, structurally, and an app can never name another one.
 */
export function resolveMcpUiBackend(
  serverId: string,
  sources: { loopback: LoopbackUiSource; mcpManager: ExternalUiSource },
): McpUiBackend {
  const source: ExternalUiSource = sources.loopback.has(serverId)
    ? sources.loopback
    : sources.mcpManager;
  return {
    readUiResource: (uri) => source.readUiResource(serverId, uri),
    resolveToolOwner: (toolName) => source.resolveToolOwner(serverId, toolName),
    resolveOperationGrantTarget: (toolName, args) =>
      source.resolveOperationGrantTarget(serverId, toolName, args),
    callTool: (toolName, args, invocation) =>
      source.callTool(serverId, toolName, args, invocation),
  };
}
