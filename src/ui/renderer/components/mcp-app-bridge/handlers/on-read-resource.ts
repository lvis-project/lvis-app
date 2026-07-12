/**
 * `onreadresource` handler — proxies `resources/read` from the app back to the
 * same main-process chokepoint that gated and fetched this card. The per-server
 * partition policy is already installed, so no new gate is introduced here.
 *
 * ─── `ui://` ONLY (fail closed) ──────────────────────────────────────────────
 * The uri is the ONE thing the app supplies (the serverId is bound at wire time), and
 * it used to travel to the read IPC untouched — an app could ask its server for ANY
 * resource, not just the UI resources this surface exists to serve. Two reasons that
 * is not acceptable even though the read is server-scoped:
 *   · it widens an MCP App's reach from "my own card's HTML" to "anything my server
 *     exposes", which is a data surface the user never consented to when they invoked
 *     a UI tool, and
 *   · every read MINTS a sandbox-proxy session token from a BOUNDED LRU, so an app
 *     looping reads evicts other live cards' tokens (their next reload 404s).
 * So the handler admits `ui://` and refuses everything else, before the IPC. Refusal is
 * a throw: the bridge turns it into a JSON-RPC error the app can actually see, unlike
 * the notification-shaped requests elsewhere in this feature.
 *
 * Extracted from `createMcpAppBridge` into its own React-free, independently
 * unit-testable module. Reaches `window.lvis.mcp` directly, exactly as the inline
 * version did — the renderer global is the existing seam.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

/** The `onreadresource` request callback shape, derived from the installed `AppBridge`. */
export type OnReadResource = NonNullable<AppBridge["onreadresource"]>;

/**
 * The only scheme an MCP App may read through this proxy. Same literal main's
 * open-detached validation and the `_meta.ui` contract use — a `ui://` resource IS the
 * card surface, and nothing else on the server is reachable from inside the sandbox.
 */
const MCP_UI_URI_PREFIX = "ui://";

export interface OnReadResourceDeps {
  /** The MCP server whose partition + policy already gated this card. */
  serverId: string;
}

export function createOnReadResource({ serverId }: OnReadResourceDeps): OnReadResource {
  return async ({ uri }) => {
    if (typeof uri !== "string" || !uri.startsWith(MCP_UI_URI_PREFIX)) {
      throw new Error("resources/read is restricted to ui:// resources");
    }
    const bundle = await window.lvis.mcp.readUiResource(serverId, uri);
    return {
      contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: bundle.html }],
    };
  };
}
