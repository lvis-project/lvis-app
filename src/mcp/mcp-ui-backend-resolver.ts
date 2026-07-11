/**
 * Unified `serverId → MCP UI backend` resolver — the SINGLE source of truth for
 * WHICH backend serves a card render's `ui://` resource (and, in a later PR, its
 * `oncalltool`). It replaces the former external-only resolution inline in the
 * `readUiResource` IPC handler so the render path and the (later) call path share
 * ONE resolution rule, never a duplicated `serverId → backend` branch.
 *
 * Resolution order — LOOPBACK FIRST, then external:
 *  1. A first-party plugin runs as an in-process loopback MCP server whose
 *     `serverId === pluginId` (`PluginLoopbackManager`). It is NEVER in
 *     `mcpManager.clients` (external-only), so it must be tried first.
 *  2. Otherwise fall back to the external MCP client registry
 *     (`McpManager.readUiResource`), which itself fails-closed ("server not
 *     found") on an unknown id.
 *
 * The returned backend is deliberately NARROW (only `readUiResource` today). The
 * `oncalltool` seam is a later PR; it extends THIS interface + this one resolver
 * with `callTool`, so the render + call paths keep sharing one resolution. No
 * consumer branches on backend kind — that is the whole point of the seam.
 */
import type { McpUiResourceRead } from "./types.js";

/** A resolved backend that can serve a card's `ui://` resource. */
export interface McpUiBackend {
  /** Read one `ui://` resource: HTML + the resource's OWN declared csp/permissions. */
  readUiResource(uri: string): Promise<McpUiResourceRead>;
  // NOTE: `callTool(...)` is intentionally NOT part of this seam yet. The
  // `oncalltool` IPC is a later PR; it adds `callTool` here so both paths reuse
  // the loopback-first resolution below without duplicating it.
}

/** The loopback surface this resolver needs (a `PluginLoopbackManager` subset). */
export interface LoopbackUiSource {
  has(serverId: string): boolean;
  readUiResource(serverId: string, uri: string): Promise<McpUiResourceRead>;
}

/** The external surface this resolver needs (an `McpManager` subset). */
export interface ExternalUiSource {
  readUiResource(serverId: string, uri: string): Promise<McpUiResourceRead>;
}

/**
 * Resolve the backend that owns `serverId`'s `ui://` resources: the plugin
 * loopback host when one is running for that id, else the external MCP client
 * registry. The returned backend closes over `serverId`, so callers pass only
 * the `uri`.
 */
export function resolveMcpUiBackend(
  serverId: string,
  sources: { loopback: LoopbackUiSource; mcpManager: ExternalUiSource },
): McpUiBackend {
  if (sources.loopback.has(serverId)) {
    return { readUiResource: (uri) => sources.loopback.readUiResource(serverId, uri) };
  }
  return { readUiResource: (uri) => sources.mcpManager.readUiResource(serverId, uri) };
}
