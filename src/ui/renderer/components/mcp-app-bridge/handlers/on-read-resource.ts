/**
 * `onreadresource` handler — proxies `resources/read` from the app back to the
 * same main-process chokepoint that gated and fetched this card. The per-server
 * partition policy is already installed, so no new gate is introduced here.
 *
 * Extracted from `createMcpAppBridge` into its own React-free, independently
 * unit-testable module. Reaches `window.lvis.mcp` directly, exactly as the inline
 * version did — the renderer global is the existing seam.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

/** The `onreadresource` request callback shape, derived from the installed `AppBridge`. */
export type OnReadResource = NonNullable<AppBridge["onreadresource"]>;

export interface OnReadResourceDeps {
  /** The MCP server whose partition + policy already gated this card. */
  serverId: string;
}

export function createOnReadResource({ serverId }: OnReadResourceDeps): OnReadResource {
  return async ({ uri }) => {
    const bundle = await window.lvis.mcp.readUiResource(serverId, uri);
    return {
      contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: bundle.html }],
    };
  };
}
